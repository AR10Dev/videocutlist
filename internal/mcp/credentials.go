// Package mcp contains the credential and authorization domain used by the
// Streamable HTTP adapter. Deployment authentication remains the administrative
// boundary; these credentials are scoped assistant credentials only.
package mcp

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"slices"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

const (
	credentialNameLimit   = 120
	credentialPageDefault = 50
	credentialPageLimit   = 100
	scopeIDLimit          = 1000
	auditAtomLimit        = 64
	auditResourceLimit    = 32
	auditPageDefault      = 50
	auditPageLimit        = 100
	credentialIDBytes     = 18
	tokenIdentifierBytes  = 12
	tokenSecretBytes      = 32
	credentialTokenPrefix = "vcl_"

	// MaxAuditEntriesPerCredential bounds retained assistant activity history.
	MaxAuditEntriesPerCredential = 1000
)

var (
	ErrCredentialNotFound            = errors.New("mcp credential not found")
	ErrCredentialUnauthorized        = errors.New("mcp credential unauthorized")
	ErrCredentialExpired             = errors.New("mcp credential expired")
	ErrCredentialRevoked             = errors.New("mcp credential revoked")
	ErrCredentialInvalid             = errors.New("invalid mcp credential")
	ErrNonExpiringCredentialNeedsAck = errors.New("non-expiring mcp credentials require explicit acknowledgement")
	ErrPermissionDenied              = errors.New("mcp permission denied")
	ErrResourceDenied                = errors.New("mcp resource denied")
	ErrAuditInvalid                  = errors.New("invalid mcp audit entry")
	ErrAuditData                     = errors.New("invalid stored mcp audit entry")
	ErrCredentialData                = errors.New("invalid stored mcp credential")
	ErrInvalidInput                  = errors.New("invalid mcp input")
)

// Permission is an operation granted to a scoped credential.
type Permission string

const (
	PermissionMediaRead       Permission = "media:read"
	PermissionProjectsRead    Permission = "projects:read"
	PermissionProjectsWrite   Permission = "projects:write"
	PermissionPreviewsCreate  Permission = "previews:create"
	PermissionDetectionRun    Permission = "detection:run"
	PermissionExportsPrepare  Permission = "exports:prepare"
	PermissionExportsRun      Permission = "exports:run"
	PermissionJobsRead        Permission = "jobs:read"
	PermissionJobsCancel      Permission = "jobs:cancel"
	PermissionExportsDownload Permission = "exports:download"
)

var knownPermissions = []Permission{
	PermissionMediaRead,
	PermissionProjectsRead,
	PermissionProjectsWrite,
	PermissionPreviewsCreate,
	PermissionDetectionRun,
	PermissionExportsPrepare,
	PermissionExportsRun,
	PermissionJobsRead,
	PermissionJobsCancel,
	PermissionExportsDownload,
}

// KnownPermissions returns the complete grant inventory in display order.
func KnownPermissions() []Permission { return slices.Clone(knownPermissions) }

// MediaScopeKind identifies which media a credential can reference.
type MediaScopeKind string

const (
	MediaScopeAll   MediaScopeKind = "all"
	MediaScopeRoots MediaScopeKind = "roots"
	MediaScopeMedia MediaScopeKind = "media"
)

// MediaScope contains only configured root IDs or opaque media IDs. It never
// stores a filesystem path.
type MediaScope struct {
	Kind     MediaScopeKind `json:"kind"`
	RootIDs  []string       `json:"rootIds,omitempty"`
	MediaIDs []string       `json:"mediaIds,omitempty"`
}

// ProjectScopeKind identifies which projects a credential can reference.
type ProjectScopeKind string

const (
	ProjectScopeAll      ProjectScopeKind = "all"
	ProjectScopeSelected ProjectScopeKind = "projects"
)

// ProjectScope contains only opaque project IDs.
type ProjectScope struct {
	Kind       ProjectScopeKind `json:"kind"`
	ProjectIDs []string         `json:"projectIds,omitempty"`
}

// Credential is the safe, non-secret representation used by administrators and
// the authorization layer. The token verifier is deliberately not a field here.
type Credential struct {
	ID                string       `json:"id"`
	TokenIdentifier   string       `json:"tokenIdentifier"`
	Name              string       `json:"name"`
	Permissions       []Permission `json:"permissions"`
	MediaScope        MediaScope   `json:"mediaScope"`
	ProjectScope      ProjectScope `json:"projectScope"`
	ExpiresAt         *time.Time   `json:"expiresAt,omitempty"`
	RevokedAt         *time.Time   `json:"revokedAt,omitempty"`
	UnattendedExports bool         `json:"unattendedExports"`
	CreatedAt         time.Time    `json:"createdAt"`
	LastUsedAt        *time.Time   `json:"lastUsedAt,omitempty"`
}

// CredentialInput is the administrator-approved data used to create a
// credential. ExpiresAt must be set unless AllowNonExpiring is explicitly true.
type CredentialInput struct {
	Name              string
	Permissions       []Permission
	MediaScope        MediaScope
	ProjectScope      ProjectScope
	ExpiresAt         *time.Time
	AllowNonExpiring  bool
	UnattendedExports bool
}

// CreatedCredential contains the one-time plaintext bearer secret. The store
// never returns this secret again after Create returns.
type CreatedCredential struct {
	Credential
	Secret string `json:"secret"`
}

// MediaResource is the authorization view of an indexed media item.
type MediaResource struct {
	ID     string
	RootID string
}

// Resource identifies opaque resources involved in one operation. A project
// operation must provide every project media item unless ProjectSummary is true.
type Resource struct {
	MediaID        string
	RootID         string
	ProjectID      string
	ProjectMedia   []MediaResource
	ProjectSummary bool
}

// AuditInput is intentionally limited to operation names, outcomes, opaque
// resource IDs, and an optional opaque job ID. It cannot carry paths or content.
type AuditInput struct {
	Operation   string
	Outcome     string
	ResourceIDs []string
	JobID       string
}

// AuditEntry is a bounded, safe activity record.
type AuditEntry struct {
	ID           int64     `json:"id"`
	CredentialID string    `json:"credentialId"`
	Operation    string    `json:"operation"`
	Outcome      string    `json:"outcome"`
	ResourceIDs  []string  `json:"resourceIds,omitempty"`
	JobID        string    `json:"jobId,omitempty"`
	OccurredAt   time.Time `json:"occurredAt"`
}

// CredentialStore persists scoped assistant credentials and audit entries.
type CredentialStore struct {
	db  *sql.DB
	now func() time.Time
}

// NewCredentialStore constructs a store over an already migrated database.
func NewCredentialStore(db *sql.DB) (*CredentialStore, error) {
	return NewCredentialStoreWithClock(db, time.Now)
}

// NewCredentialStoreWithClock is useful for deterministic expiry tests while
// keeping production time sourced from the system clock.
func NewCredentialStoreWithClock(db *sql.DB, now func() time.Time) (*CredentialStore, error) {
	if db == nil {
		return nil, errors.New("mcp credential database is required")
	}
	if now == nil {
		return nil, errors.New("mcp credential clock is required")
	}
	return &CredentialStore{db: db, now: now}, nil
}

// Create generates a high-entropy bearer token and persists only its SHA-256
// verifier plus a non-secret lookup identifier. The token has 256 bits of
// randomness, so this verifier is not used for password-like low-entropy input.
func (s *CredentialStore) Create(ctx context.Context, input CredentialInput) (CreatedCredential, error) {
	normalized, err := normalizeCredentialInput(input, s.currentTime())
	if err != nil {
		return CreatedCredential{}, err
	}
	id, err := randomIdentifier("c_", credentialIDBytes)
	if err != nil {
		return CreatedCredential{}, fmt.Errorf("generate credential ID: %w", err)
	}
	tokenIdentifier, err := randomIdentifier("t_", tokenIdentifierBytes)
	if err != nil {
		return CreatedCredential{}, fmt.Errorf("generate token identifier: %w", err)
	}
	secretBytes := make([]byte, tokenSecretBytes)
	if _, err := io.ReadFull(rand.Reader, secretBytes); err != nil {
		return CreatedCredential{}, fmt.Errorf("generate credential secret: %w", err)
	}
	secret := credentialTokenPrefix + tokenIdentifier + "." + base64.RawURLEncoding.EncodeToString(secretBytes)
	verifier := tokenVerifier(secret)
	permissions, err := json.Marshal(normalized.Permissions)
	if err != nil {
		return CreatedCredential{}, fmt.Errorf("encode credential permissions: %w", err)
	}
	mediaScope, err := json.Marshal(normalized.MediaScope)
	if err != nil {
		return CreatedCredential{}, fmt.Errorf("encode media scope: %w", err)
	}
	projectScope, err := json.Marshal(normalized.ProjectScope)
	if err != nil {
		return CreatedCredential{}, fmt.Errorf("encode project scope: %w", err)
	}
	created := s.currentTime()
	createdText := formatTime(created)
	var expires any
	if normalized.ExpiresAt != nil {
		expires = formatTime(*normalized.ExpiresAt)
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return CreatedCredential{}, fmt.Errorf("begin credential creation: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	_, err = tx.ExecContext(ctx, `INSERT INTO mcp_credentials
(id, token_identifier, token_verifier, name, permissions_json, media_scope_json, project_scope_json, expires_at, revoked_at, unattended_exports, created_at, last_used_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, ?)`,
		id, tokenIdentifier, verifier, normalized.Name, string(permissions), string(mediaScope), string(projectScope), expires, normalized.UnattendedExports, createdText, createdText)
	if err != nil {
		return CreatedCredential{}, fmt.Errorf("create mcp credential: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return CreatedCredential{}, fmt.Errorf("commit mcp credential: %w", err)
	}
	credential := Credential{
		ID: id, TokenIdentifier: tokenIdentifier, Name: normalized.Name,
		Permissions: slices.Clone(normalized.Permissions), MediaScope: cloneMediaScope(normalized.MediaScope),
		ProjectScope: cloneProjectScope(normalized.ProjectScope), ExpiresAt: cloneTime(normalized.ExpiresAt),
		UnattendedExports: normalized.UnattendedExports, CreatedAt: created,
	}
	return CreatedCredential{Credential: credential, Secret: secret}, nil
}

// Get returns safe credential metadata, including revoked and expired records
// for administrative status views.
func (s *CredentialStore) Get(ctx context.Context, id string) (Credential, error) {
	if !validCredentialID(id) {
		return Credential{}, ErrCredentialNotFound
	}
	record, err := s.getRecord(ctx, id)
	if err != nil {
		return Credential{}, err
	}
	return cloneCredential(record.Credential), nil
}

// GetActive rechecks revocation and expiry for a session invocation.
func (s *CredentialStore) GetActive(ctx context.Context, id string) (Credential, error) {
	credential, err := s.Get(ctx, id)
	if err != nil {
		return Credential{}, err
	}
	if err := credential.activeAt(s.currentTime()); err != nil {
		return Credential{}, err
	}
	return credential, nil
}

// List returns bounded safe metadata in opaque-ID order. A non-empty cursor is
// exclusive and must be a credential ID returned by an earlier page.
func (s *CredentialStore) List(ctx context.Context, cursor string, limit int) ([]Credential, *string, error) {
	if cursor != "" && !validCredentialID(cursor) {
		return nil, nil, ErrCredentialNotFound
	}
	limit = boundedLimit(limit, credentialPageDefault, credentialPageLimit)
	rows, err := s.db.QueryContext(ctx, `SELECT id, token_identifier, token_verifier, name, permissions_json, media_scope_json, project_scope_json, expires_at, revoked_at, unattended_exports, created_at, last_used_at, updated_at
FROM mcp_credentials WHERE id > ? ORDER BY id LIMIT ?`, cursor, limit+1)
	if err != nil {
		return nil, nil, fmt.Errorf("list mcp credentials: %w", err)
	}
	defer func() { _ = rows.Close() }()
	credentials := make([]Credential, 0, 16)
	for rows.Next() {
		record, err := scanCredential(rows)
		if err != nil {
			return nil, nil, err
		}
		if len(credentials) == limit {
			next := credentials[len(credentials)-1].ID
			return credentials, new(next), nil
		}
		credentials = append(credentials, record.Credential)
	}
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	return credentials, nil, nil
}

// GrantProject adds one newly created project to a selected scope without
// changing the credential's media scope. An all-project scope needs no change.
func (s *CredentialStore) GrantProject(ctx context.Context, credentialID, projectID string) (Credential, error) {
	if !validCredentialID(credentialID) || !validSafeIdentifier(projectID) {
		return Credential{}, ErrCredentialNotFound
	}
	var granted Credential
	err := s.withTransaction(ctx, func(tx *sql.Tx) error {
		var err error
		granted, err = s.grantProjectTx(ctx, tx, credentialID, projectID)
		return err
	})
	if err != nil {
		return Credential{}, err
	}
	return granted, nil
}

func (s *CredentialStore) withTransaction(ctx context.Context, fn func(*sql.Tx) error) (err error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin mcp transaction: %w", err)
	}
	defer func() {
		if rollbackErr := tx.Rollback(); rollbackErr != nil && !errors.Is(rollbackErr, sql.ErrTxDone) {
			err = errors.Join(err, fmt.Errorf("rollback mcp transaction: %w", rollbackErr))
		}
	}()
	if err := fn(tx); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit mcp transaction: %w", err)
	}
	return nil
}

func (s *CredentialStore) grantProjectTx(ctx context.Context, tx *sql.Tx, credentialID, projectID string) (Credential, error) {
	if tx == nil || !validCredentialID(credentialID) || !validSafeIdentifier(projectID) {
		return Credential{}, ErrCredentialNotFound
	}
	record, err := scanCredential(tx.QueryRowContext(ctx, `SELECT id, token_identifier, token_verifier, name, permissions_json, media_scope_json, project_scope_json, expires_at, revoked_at, unattended_exports, created_at, last_used_at, updated_at FROM mcp_credentials WHERE id = ?`, credentialID))
	if errors.Is(err, sql.ErrNoRows) {
		return Credential{}, ErrCredentialNotFound
	}
	if err != nil {
		return Credential{}, err
	}
	if err := record.activeAt(s.currentTime()); err != nil {
		return Credential{}, err
	}
	if record.ProjectScope.Kind == ProjectScopeAll || slices.Contains(record.ProjectScope.ProjectIDs, projectID) {
		return cloneCredential(record.Credential), nil
	}
	if len(record.ProjectScope.ProjectIDs) >= scopeIDLimit {
		return Credential{}, ErrCredentialInvalid
	}
	record.ProjectScope.ProjectIDs = append(record.ProjectScope.ProjectIDs, projectID)
	slices.Sort(record.ProjectScope.ProjectIDs)
	scope, err := json.Marshal(record.ProjectScope)
	if err != nil {
		return Credential{}, err
	}
	now := s.currentTime()
	result, err := tx.ExecContext(ctx, `UPDATE mcp_credentials SET project_scope_json = ?, updated_at = ? WHERE id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`, string(scope), formatTime(now), credentialID, formatTime(now))
	if err != nil {
		return Credential{}, fmt.Errorf("grant mcp project: %w", err)
	}
	updated, err := result.RowsAffected()
	if err != nil {
		return Credential{}, err
	}
	if updated != 1 {
		return Credential{}, ErrCredentialUnauthorized
	}
	return cloneCredential(record.Credential), nil
}

// Revoke marks a credential revoked. It is idempotent and cannot be reversed.
func (s *CredentialStore) Revoke(ctx context.Context, id string) (Credential, error) {
	if !validCredentialID(id) {
		return Credential{}, ErrCredentialNotFound
	}
	now := s.currentTime()
	result, err := s.db.ExecContext(ctx, `UPDATE mcp_credentials
SET revoked_at = COALESCE(revoked_at, ?), updated_at = ? WHERE id = ?`, formatTime(now), formatTime(now), id)
	if err != nil {
		return Credential{}, fmt.Errorf("revoke mcp credential: %w", err)
	}
	if affected, err := result.RowsAffected(); err != nil {
		return Credential{}, err
	} else if affected == 0 {
		return Credential{}, ErrCredentialNotFound
	}
	return s.Get(ctx, id)
}

// Authenticate verifies a bearer secret and updates last-used state only while
// the credential remains active. Revocation is checked by the conditional write.
func (s *CredentialStore) Authenticate(ctx context.Context, token string) (Credential, error) {
	tokenIdentifier, ok := parseTokenIdentifier(token)
	if !ok {
		return Credential{}, ErrCredentialUnauthorized
	}
	record, err := s.getByTokenIdentifier(ctx, tokenIdentifier)
	if errors.Is(err, ErrCredentialNotFound) {
		return Credential{}, ErrCredentialUnauthorized
	}
	if err != nil {
		return Credential{}, err
	}
	if subtle.ConstantTimeCompare([]byte(record.tokenVerifier), []byte(tokenVerifier(token))) != 1 {
		return Credential{}, ErrCredentialUnauthorized
	}
	credential, err := s.TouchLastUsed(ctx, record.ID)
	if err != nil {
		if errors.Is(err, ErrCredentialExpired) || errors.Is(err, ErrCredentialRevoked) {
			return Credential{}, fmt.Errorf("%w: %w", ErrCredentialUnauthorized, err)
		}
		if errors.Is(err, ErrCredentialNotFound) {
			return Credential{}, ErrCredentialUnauthorized
		}
		return Credential{}, err
	}
	return credential, nil
}

// Authorize authenticates a bearer secret and checks permission plus resource
// scope in one call. The returned identity is empty on denial.
func (s *CredentialStore) Authorize(ctx context.Context, token string, permission Permission, resource Resource) (Credential, error) {
	credential, err := s.Authenticate(ctx, token)
	if err != nil {
		return Credential{}, err
	}
	if !credential.Allows(permission, resource) {
		if credential.HasPermission(permission) {
			return Credential{}, ErrResourceDenied
		}
		return Credential{}, ErrPermissionDenied
	}
	return credential, nil
}

// AuthorizeCredential rechecks an already-established session identity before
// each invocation; credential IDs alone are not accepted as authentication.
func (s *CredentialStore) AuthorizeCredential(ctx context.Context, credentialID string, permission Permission, resource Resource) (Credential, error) {
	credential, err := s.TouchLastUsed(ctx, credentialID)
	if err != nil {
		return Credential{}, fmt.Errorf("%w: %w", ErrCredentialUnauthorized, err)
	}
	if !credential.Allows(permission, resource) {
		if credential.HasPermission(permission) {
			return Credential{}, ErrResourceDenied
		}
		return Credential{}, ErrPermissionDenied
	}
	return credential, nil
}

// TouchLastUsed rechecks status and records a session invocation without
// requiring the bearer secret again. Callers must only use it for an identity
// established by Authenticate.
func (s *CredentialStore) TouchLastUsed(ctx context.Context, id string) (Credential, error) {
	if !validCredentialID(id) {
		return Credential{}, ErrCredentialNotFound
	}
	record, err := s.getRecord(ctx, id)
	if err != nil {
		return Credential{}, err
	}
	now := s.currentTime()
	if err := record.activeAt(now); err != nil {
		return Credential{}, err
	}
	result, err := s.db.ExecContext(ctx, `UPDATE mcp_credentials
SET last_used_at = ?, updated_at = ?
WHERE id = ? AND revoked_at IS NULL`, formatTime(now), formatTime(now), id)
	if err != nil {
		return Credential{}, fmt.Errorf("update mcp credential usage: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return Credential{}, err
	}
	if affected != 1 {
		active, activeErr := s.getRecord(ctx, id)
		if activeErr != nil {
			return Credential{}, activeErr
		}
		if statusErr := active.activeAt(s.currentTime()); statusErr != nil {
			return Credential{}, statusErr
		}
		record = active
	}
	record.LastUsedAt = new(now)
	return cloneCredential(record.Credential), nil
}

// RecordAudit appends a bounded safe audit entry. It does not accept arbitrary
// details, paths, token material, or conversational content.
func (s *CredentialStore) RecordAudit(ctx context.Context, credentialID string, input AuditInput) (AuditEntry, error) {
	if !validCredentialID(credentialID) {
		return AuditEntry{}, ErrCredentialNotFound
	}
	normalized, err := normalizeAuditInput(input)
	if err != nil {
		return AuditEntry{}, err
	}
	resources, err := json.Marshal(normalized.ResourceIDs)
	if err != nil {
		return AuditEntry{}, ErrAuditInvalid
	}
	now := s.currentTime()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return AuditEntry{}, fmt.Errorf("begin mcp audit: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	var exists int
	if err := tx.QueryRowContext(ctx, `SELECT 1 FROM mcp_credentials WHERE id = ?`, credentialID).Scan(&exists); errors.Is(err, sql.ErrNoRows) {
		return AuditEntry{}, ErrCredentialNotFound
	} else if err != nil {
		return AuditEntry{}, fmt.Errorf("check mcp credential for audit: %w", err)
	}
	result, err := tx.ExecContext(ctx, `INSERT INTO mcp_audit_entries
(credential_id, operation, outcome, resource_ids_json, job_id, occurred_at)
VALUES (?, ?, ?, ?, ?, ?)`, credentialID, normalized.Operation, normalized.Outcome, string(resources), nullableString(normalized.JobID), formatTime(now))
	if err != nil {
		return AuditEntry{}, fmt.Errorf("record mcp audit: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM mcp_audit_entries
WHERE credential_id = ? AND id IN (
  SELECT id FROM mcp_audit_entries WHERE credential_id = ?
  ORDER BY id DESC LIMIT -1 OFFSET ?
)`, credentialID, credentialID, MaxAuditEntriesPerCredential); err != nil {
		return AuditEntry{}, fmt.Errorf("bound mcp audit: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return AuditEntry{}, fmt.Errorf("commit mcp audit: %w", err)
	}
	id, err := result.LastInsertId()
	if err != nil {
		return AuditEntry{}, err
	}
	return AuditEntry{ID: id, CredentialID: credentialID, Operation: normalized.Operation, Outcome: normalized.Outcome, ResourceIDs: slices.Clone(normalized.ResourceIDs), JobID: normalized.JobID, OccurredAt: now}, nil
}

// ListAudit returns the newest bounded audit entries for a credential.
func (s *CredentialStore) ListAudit(ctx context.Context, credentialID string, limit int) ([]AuditEntry, error) {
	return s.ListAuditBefore(ctx, credentialID, 0, limit)
}

// ListAuditBefore returns entries older than beforeID when beforeID is nonzero.
func (s *CredentialStore) ListAuditBefore(ctx context.Context, credentialID string, beforeID int64, limit int) ([]AuditEntry, error) {
	if !validCredentialID(credentialID) || beforeID < 0 {
		return nil, ErrCredentialNotFound
	}
	if _, err := s.Get(ctx, credentialID); err != nil {
		return nil, err
	}
	limit = boundedLimit(limit, auditPageDefault, auditPageLimit)
	var rows *sql.Rows
	var err error
	if beforeID == 0 {
		rows, err = s.db.QueryContext(ctx, `SELECT id, credential_id, operation, outcome, resource_ids_json, job_id, occurred_at
FROM mcp_audit_entries WHERE credential_id = ? ORDER BY id DESC LIMIT ?`, credentialID, limit)
	} else {
		rows, err = s.db.QueryContext(ctx, `SELECT id, credential_id, operation, outcome, resource_ids_json, job_id, occurred_at
FROM mcp_audit_entries WHERE credential_id = ? AND id < ? ORDER BY id DESC LIMIT ?`, credentialID, beforeID, limit)
	}
	if err != nil {
		return nil, fmt.Errorf("list mcp audit: %w", err)
	}
	defer func() { _ = rows.Close() }()
	entries := make([]AuditEntry, 0, limit)
	for rows.Next() {
		entry, err := scanAuditEntry(rows)
		if err != nil {
			return nil, err
		}
		entries = append(entries, entry)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return entries, nil
}

// HasPermission reports whether the credential has one explicit operation grant.
func (c Credential) HasPermission(permission Permission) bool {
	return slices.Contains(c.Permissions, permission)
}

// ActiveAt checks status at the supplied instant.
func (c Credential) ActiveAt(now time.Time) bool {
	return c.activeAt(now.UTC()) == nil
}

// AllowsMedia checks the media scope without consulting filesystem paths.
func (c Credential) AllowsMedia(mediaID, rootID string) bool {
	return c.MediaScope.allows(mediaID, rootID)
}

// AllowsProjectSummary checks project scope for list/summary operations.
func (c Credential) AllowsProjectSummary(projectID string) bool {
	return validSafeIdentifier(projectID) && c.ProjectScope.allows(projectID)
}

// AllowsProject requires every media item in a full project to be in scope.
func (c Credential) AllowsProject(projectID string, media []MediaResource) bool {
	if !c.AllowsProjectSummary(projectID) || len(media) == 0 {
		return false
	}
	for _, item := range media {
		if !c.AllowsMedia(item.ID, item.RootID) {
			return false
		}
	}
	return true
}

// AllowsCreateProject requires project-write, media-read, and authorized media.
func (c Credential) AllowsCreateProject(media []MediaResource) bool {
	return c.HasPermission(PermissionProjectsRead) && c.HasPermission(PermissionProjectsWrite) && c.allowsAllMedia(media)
}

// AllowsUnattendedExport reports whether this credential can bypass app approval
// for an export; validation and all other limits still apply elsewhere.
func (c Credential) AllowsUnattendedExport() bool {
	return c.UnattendedExports && c.HasPermission(PermissionExportsRun)
}

// Allows evaluates one permission and all resource scope constraints. Job
// ownership is intentionally checked by the job service, not inferred here.
func (c Credential) Allows(permission Permission, resource Resource) bool {
	if !c.HasPermission(permission) {
		return false
	}
	switch permission {
	case PermissionMediaRead:
		return resource.MediaID == "" || c.AllowsMedia(resource.MediaID, resource.RootID)
	case PermissionPreviewsCreate:
		return c.AllowsMedia(resource.MediaID, resource.RootID)
	case PermissionDetectionRun:
		if !c.AllowsMedia(resource.MediaID, resource.RootID) {
			return false
		}
		if resource.ProjectID == "" {
			return true
		}
		return c.allowsProjectResource(resource)
	case PermissionProjectsRead:
		return resource.ProjectID == "" && resource.ProjectSummary || c.allowsProjectResource(resource)
	case PermissionProjectsWrite:
		if resource.ProjectID == "" {
			return c.AllowsCreateProject(resource.ProjectMedia)
		}
		return c.allowsProjectResource(resource)
	case PermissionExportsPrepare, PermissionExportsRun, PermissionExportsDownload:
		return c.allowsExportResource(resource)
	case PermissionJobsRead, PermissionJobsCancel:
		if resource.ProjectID != "" {
			return c.allowsProjectResource(resource)
		}
		if len(resource.ProjectMedia) > 0 {
			return c.allowsAllMedia(resource.ProjectMedia)
		}
		if resource.MediaID != "" {
			return c.AllowsMedia(resource.MediaID, resource.RootID)
		}
		return true
	default:
		return false
	}
}

func (c Credential) allowsExportResource(resource Resource) bool {
	if resource.ProjectID != "" {
		return c.allowsProjectResource(resource)
	}
	if len(resource.ProjectMedia) > 0 {
		return c.inMediaScope(resource.ProjectMedia)
	}
	return resource.MediaID != "" && c.AllowsMedia(resource.MediaID, resource.RootID)
}

func (c Credential) allowsProjectResource(resource Resource) bool {
	if resource.ProjectSummary && len(resource.ProjectMedia) == 0 {
		if !c.AllowsProjectSummary(resource.ProjectID) {
			return false
		}
		return resource.MediaID == "" || c.AllowsMedia(resource.MediaID, resource.RootID)
	}
	if !c.AllowsProject(resource.ProjectID, resource.ProjectMedia) {
		return false
	}
	return resource.MediaID == "" || c.AllowsMedia(resource.MediaID, resource.RootID)
}

func (c Credential) inMediaScope(media []MediaResource) bool {
	if len(media) == 0 {
		return false
	}
	for _, item := range media {
		if !c.AllowsMedia(item.ID, item.RootID) {
			return false
		}
	}
	return true
}

func (c Credential) allowsAllMedia(media []MediaResource) bool {
	if len(media) == 0 || !c.HasPermission(PermissionMediaRead) {
		return false
	}
	for _, item := range media {
		if !c.AllowsMedia(item.ID, item.RootID) {
			return false
		}
	}
	return true
}

func (scope MediaScope) allows(mediaID, rootID string) bool {
	if !validSafeIdentifier(mediaID) {
		return false
	}
	switch scope.Kind {
	case MediaScopeAll:
		return len(scope.RootIDs) == 0 && len(scope.MediaIDs) == 0
	case MediaScopeRoots:
		return validSafeIdentifier(rootID) && slices.Contains(scope.RootIDs, rootID)
	case MediaScopeMedia:
		return slices.Contains(scope.MediaIDs, mediaID)
	default:
		return false
	}
}

func (scope ProjectScope) allows(projectID string) bool {
	switch scope.Kind {
	case ProjectScopeAll:
		return len(scope.ProjectIDs) == 0
	case ProjectScopeSelected:
		return slices.Contains(scope.ProjectIDs, projectID)
	default:
		return false
	}
}

func (c Credential) activeAt(now time.Time) error {
	if c.RevokedAt != nil {
		return ErrCredentialRevoked
	}
	if c.ExpiresAt != nil && !c.ExpiresAt.After(now) {
		return ErrCredentialExpired
	}
	return nil
}

func normalizeCredentialInput(input CredentialInput, now time.Time) (CredentialInput, error) {
	if !utf8.ValidString(input.Name) || strings.TrimSpace(input.Name) == "" || utf8.RuneCountInString(input.Name) > credentialNameLimit || strings.IndexFunc(input.Name, unicode.IsControl) >= 0 {
		return CredentialInput{}, ErrCredentialInvalid
	}
	input.Name = strings.TrimSpace(input.Name)
	permissions, err := normalizePermissions(input.Permissions)
	if err != nil {
		return CredentialInput{}, err
	}
	mediaScope, err := normalizeMediaScope(input.MediaScope)
	if err != nil {
		return CredentialInput{}, err
	}
	projectScope, err := normalizeProjectScope(input.ProjectScope)
	if err != nil {
		return CredentialInput{}, err
	}
	if input.ExpiresAt == nil {
		if !input.AllowNonExpiring {
			return CredentialInput{}, ErrNonExpiringCredentialNeedsAck
		}
	} else {
		expires := input.ExpiresAt.UTC()
		if !expires.After(now) {
			return CredentialInput{}, ErrCredentialExpired
		}
		input.ExpiresAt = new(expires)
	}
	input.Permissions = permissions
	input.MediaScope = mediaScope
	input.ProjectScope = projectScope
	return input, nil
}

func normalizePermissions(permissions []Permission) ([]Permission, error) {
	result := make([]Permission, 0, len(permissions))
	for _, permission := range permissions {
		if !slices.Contains(knownPermissions, permission) || slices.Contains(result, permission) {
			return nil, ErrCredentialInvalid
		}
		result = append(result, permission)
	}
	slices.Sort(result)
	if slices.Contains(result, PermissionProjectsWrite) && !slices.Contains(result, PermissionProjectsRead) {
		return nil, ErrCredentialInvalid
	}
	return result, nil
}

func normalizeMediaScope(scope MediaScope) (MediaScope, error) {
	scope.RootIDs = slices.Clone(scope.RootIDs)
	scope.MediaIDs = slices.Clone(scope.MediaIDs)
	switch scope.Kind {
	case MediaScopeAll:
		if len(scope.RootIDs) != 0 || len(scope.MediaIDs) != 0 {
			return MediaScope{}, ErrCredentialInvalid
		}
	case MediaScopeRoots:
		if len(scope.RootIDs) == 0 || len(scope.RootIDs) > scopeIDLimit || len(scope.MediaIDs) != 0 || !validIDList(scope.RootIDs) {
			return MediaScope{}, ErrCredentialInvalid
		}
		slices.Sort(scope.RootIDs)
	case MediaScopeMedia:
		if len(scope.MediaIDs) == 0 || len(scope.MediaIDs) > scopeIDLimit || len(scope.RootIDs) != 0 || !validIDList(scope.MediaIDs) {
			return MediaScope{}, ErrCredentialInvalid
		}
		slices.Sort(scope.MediaIDs)
	default:
		return MediaScope{}, ErrCredentialInvalid
	}
	return scope, nil
}

func normalizeProjectScope(scope ProjectScope) (ProjectScope, error) {
	scope.ProjectIDs = slices.Clone(scope.ProjectIDs)
	switch scope.Kind {
	case ProjectScopeAll:
		if len(scope.ProjectIDs) != 0 {
			return ProjectScope{}, ErrCredentialInvalid
		}
	case ProjectScopeSelected:
		if len(scope.ProjectIDs) == 0 || len(scope.ProjectIDs) > scopeIDLimit || !validIDList(scope.ProjectIDs) {
			return ProjectScope{}, ErrCredentialInvalid
		}
		slices.Sort(scope.ProjectIDs)
	default:
		return ProjectScope{}, ErrCredentialInvalid
	}
	return scope, nil
}

func validIDList(values []string) bool {
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		if !validSafeIdentifier(value) {
			return false
		}
		if _, ok := seen[value]; ok {
			return false
		}
		seen[value] = struct{}{}
	}
	return true
}

func normalizeAuditInput(input AuditInput) (AuditInput, error) {
	if !validAuditAtom(input.Operation) || !validAuditAtom(input.Outcome) || len(input.ResourceIDs) > auditResourceLimit || input.JobID != "" && !validSafeIdentifier(input.JobID) {
		return AuditInput{}, ErrAuditInvalid
	}
	input.ResourceIDs = slices.Clone(input.ResourceIDs)
	if !validIDList(input.ResourceIDs) {
		return AuditInput{}, ErrAuditInvalid
	}
	slices.Sort(input.ResourceIDs)
	return input, nil
}

func validAuditAtom(value string) bool {
	if value == "" || len(value) > auditAtomLimit {
		return false
	}
	for _, character := range value {
		if !validIdentifierCharacter(character, true) {
			return false
		}
	}
	return true
}

func validSafeIdentifier(value string) bool {
	if value == "" || len(value) > 128 {
		return false
	}
	for _, character := range value {
		if !validIdentifierCharacter(character, false) {
			return false
		}
	}
	return true
}

func validIdentifierCharacter(character rune, colon bool) bool {
	return character >= 'a' && character <= 'z' || character >= 'A' && character <= 'Z' || character >= '0' && character <= '9' || character == '_' || character == '-' || colon && character == ':'
}

func validCredentialID(value string) bool {
	return strings.HasPrefix(value, "c_") && validSafeIdentifier(value)
}

func randomIdentifier(prefix string, size int) (string, error) {
	value := make([]byte, size)
	if _, err := io.ReadFull(rand.Reader, value); err != nil {
		return "", err
	}
	return prefix + base64.RawURLEncoding.EncodeToString(value), nil
}

func parseTokenIdentifier(token string) (string, bool) {
	if len(token) > 256 {
		return "", false
	}
	body, ok := strings.CutPrefix(token, credentialTokenPrefix)
	if !ok {
		return "", false
	}
	identifier, encoded, ok := strings.Cut(body, ".")
	if !ok || !strings.HasPrefix(identifier, "t_") || !validSafeIdentifier(identifier) || encoded == "" {
		return "", false
	}
	secret, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil || len(secret) != tokenSecretBytes {
		return "", false
	}
	return identifier, true
}

func tokenVerifier(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func (s *CredentialStore) currentTime() time.Time {
	return s.now().UTC()
}

func (s *CredentialStore) getRecord(ctx context.Context, id string) (credentialRecord, error) {
	row := s.db.QueryRowContext(ctx, `SELECT id, token_identifier, token_verifier, name, permissions_json, media_scope_json, project_scope_json, expires_at, revoked_at, unattended_exports, created_at, last_used_at, updated_at
FROM mcp_credentials WHERE id = ?`, id)
	record, err := scanCredential(row)
	if errors.Is(err, sql.ErrNoRows) {
		return credentialRecord{}, ErrCredentialNotFound
	}
	return record, err
}

func (s *CredentialStore) getByTokenIdentifier(ctx context.Context, identifier string) (credentialRecord, error) {
	row := s.db.QueryRowContext(ctx, `SELECT id, token_identifier, token_verifier, name, permissions_json, media_scope_json, project_scope_json, expires_at, revoked_at, unattended_exports, created_at, last_used_at, updated_at
FROM mcp_credentials WHERE token_identifier = ?`, identifier)
	record, err := scanCredential(row)
	if errors.Is(err, sql.ErrNoRows) {
		return credentialRecord{}, ErrCredentialNotFound
	}
	return record, err
}

type credentialRecord struct {
	Credential
	tokenVerifier string
}

type credentialScanner interface {
	Scan(...any) error
}

func scanCredential(row credentialScanner) (credentialRecord, error) {
	var record credentialRecord
	var permissionsJSON, mediaScopeJSON, projectScopeJSON string
	var projectScope ProjectScope
	var expires, revoked, lastUsed sql.NullString
	var unattended int
	var created, updated string
	if err := row.Scan(&record.ID, &record.TokenIdentifier, &record.tokenVerifier, &record.Name, &permissionsJSON, &mediaScopeJSON, &projectScopeJSON, &expires, &revoked, &unattended, &created, &lastUsed, &updated); err != nil {
		return credentialRecord{}, err
	}
	if !validCredentialID(record.ID) || !strings.HasPrefix(record.TokenIdentifier, "t_") || !validSafeIdentifier(record.TokenIdentifier) || len(record.tokenVerifier) != sha256.Size*2 {
		return credentialRecord{}, ErrCredentialData
	}
	if _, err := hex.DecodeString(record.tokenVerifier); err != nil {
		return credentialRecord{}, ErrCredentialData
	}
	if err := decodeJSON(permissionsJSON, &record.Permissions); err != nil {
		return credentialRecord{}, fmt.Errorf("%w: permissions", ErrCredentialData)
	}
	if err := decodeJSON(mediaScopeJSON, &record.MediaScope); err != nil {
		return credentialRecord{}, fmt.Errorf("%w: media scope", ErrCredentialData)
	}
	if err := decodeJSON(projectScopeJSON, &projectScope); err != nil {
		return credentialRecord{}, fmt.Errorf("%w: project scope", ErrCredentialData)
	}
	if normalized, err := normalizePermissions(record.Permissions); err != nil {
		return credentialRecord{}, fmt.Errorf("%w: permissions", ErrCredentialData)
	} else {
		record.Permissions = normalized
	}
	if normalized, err := normalizeMediaScope(record.MediaScope); err != nil {
		return credentialRecord{}, fmt.Errorf("%w: media scope", ErrCredentialData)
	} else {
		record.MediaScope = normalized
	}
	if normalized, err := normalizeProjectScope(projectScope); err != nil {
		return credentialRecord{}, fmt.Errorf("%w: project scope", ErrCredentialData)
	} else {
		record.ProjectScope = normalized
	}
	if !validCredentialName(record.Name) || unattended != 0 && unattended != 1 {
		return credentialRecord{}, ErrCredentialData
	}
	record.UnattendedExports = unattended == 1
	var err error
	if record.CreatedAt, err = parseTime(created); err != nil {
		return credentialRecord{}, fmt.Errorf("%w: created time", ErrCredentialData)
	}
	if _, err = parseTime(updated); err != nil {
		return credentialRecord{}, fmt.Errorf("%w: updated time", ErrCredentialData)
	}
	if expires.Valid {
		value, err := parseTime(expires.String)
		if err != nil {
			return credentialRecord{}, fmt.Errorf("%w: expiry", ErrCredentialData)
		}
		record.ExpiresAt = new(value)
	}
	if revoked.Valid {
		value, err := parseTime(revoked.String)
		if err != nil {
			return credentialRecord{}, fmt.Errorf("%w: revocation", ErrCredentialData)
		}
		record.RevokedAt = new(value)
	}
	if lastUsed.Valid {
		value, err := parseTime(lastUsed.String)
		if err != nil {
			return credentialRecord{}, fmt.Errorf("%w: last used", ErrCredentialData)
		}
		record.LastUsedAt = new(value)
	}
	return record, nil
}

func scanAuditEntry(row credentialScanner) (AuditEntry, error) {
	var entry AuditEntry
	var resourcesJSON string
	var jobID sql.NullString
	var occurred string
	if err := row.Scan(&entry.ID, &entry.CredentialID, &entry.Operation, &entry.Outcome, &resourcesJSON, &jobID, &occurred); err != nil {
		return AuditEntry{}, err
	}
	if entry.ID < 1 || !validCredentialID(entry.CredentialID) || !validAuditAtom(entry.Operation) || !validAuditAtom(entry.Outcome) || jobID.Valid && !validSafeIdentifier(jobID.String) || decodeJSON(resourcesJSON, &entry.ResourceIDs) != nil || !validIDList(entry.ResourceIDs) || len(entry.ResourceIDs) > auditResourceLimit {
		return AuditEntry{}, ErrAuditData
	}
	occurredAt, err := parseTime(occurred)
	if err != nil {
		return AuditEntry{}, ErrAuditData
	}
	entry.OccurredAt = occurredAt
	entry.JobID = jobID.String
	return entry, nil
}

func decodeJSON(raw string, destination any) error {
	decoder := json.NewDecoder(strings.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return errors.New("trailing JSON data")
	}
	return nil
}

func validCredentialName(value string) bool {
	return utf8.ValidString(value) && strings.TrimSpace(value) != "" && utf8.RuneCountInString(value) <= credentialNameLimit && strings.IndexFunc(value, unicode.IsControl) < 0
}

func cloneCredential(value Credential) Credential {
	value.Permissions = slices.Clone(value.Permissions)
	value.MediaScope = cloneMediaScope(value.MediaScope)
	value.ProjectScope = cloneProjectScope(value.ProjectScope)
	value.ExpiresAt = cloneTime(value.ExpiresAt)
	value.RevokedAt = cloneTime(value.RevokedAt)
	value.LastUsedAt = cloneTime(value.LastUsedAt)
	return value
}

func cloneMediaScope(value MediaScope) MediaScope {
	value.RootIDs = slices.Clone(value.RootIDs)
	value.MediaIDs = slices.Clone(value.MediaIDs)
	return value
}

func cloneProjectScope(value ProjectScope) ProjectScope {
	value.ProjectIDs = slices.Clone(value.ProjectIDs)
	return value
}

func cloneTime(value *time.Time) *time.Time {
	if value == nil {
		return nil
	}
	copy := value.UTC()
	return new(copy)
}

func formatTime(value time.Time) string {
	return value.UTC().Format(time.RFC3339Nano)
}

func parseTime(value string) (time.Time, error) {
	return time.Parse(time.RFC3339Nano, value)
}

func nullableString(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func boundedLimit(value, fallback, maximum int) int {
	if value <= 0 {
		return fallback
	}
	return min(value, maximum)
}
