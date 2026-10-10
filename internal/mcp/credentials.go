// Package mcp contains the credential and authorization domain used by the
// Streamable HTTP adapter. Deployment authentication remains the administrative
// boundary; these credentials are scoped assistant credentials only.
package mcp

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
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

	store "videocutlist/internal/db"
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

// CredentialRepository persists credentials and bounded audit history. Grant
// callbacks apply MCP policy and receive no SQL handle.
type CredentialRepository interface {
	CreateCredential(context.Context, store.MCPCredentialRecord) error
	GetCredential(context.Context, string) (store.MCPCredentialRecord, error)
	GetCredentialByTokenIdentifier(context.Context, string) (store.MCPCredentialRecord, error)
	ListCredentials(context.Context, string, int) ([]store.MCPCredentialRecord, error)
	RevokeCredential(context.Context, string, string) (store.MCPCredentialRecord, error)
	TouchCredential(context.Context, string, string) (store.MCPCredentialRecord, bool, error)
	UpdateCredentialProjectScope(context.Context, string, string, func(store.MCPCredentialRecord) (store.MCPProjectScopeUpdate, error)) (store.MCPCredentialRecord, error)
	CreateProjectAndGrant(context.Context, store.ProjectRecord, string, string, func(store.MCPCredentialRecord) (store.MCPProjectScopeUpdate, error)) (store.ProjectRecord, store.MCPCredentialRecord, error)
	AppendAudit(context.Context, store.MCPAuditRecord, int) (store.MCPAuditRecord, error)
	ListAudit(context.Context, string, int64, int) ([]store.MCPAuditRecord, error)
}

// CredentialStore applies credential and authorization policy over a repository.
type CredentialStore struct {
	repository CredentialRepository
	now        func() time.Time
}

func NewCredentialStore(repository CredentialRepository) (*CredentialStore, error) {
	return NewCredentialStoreWithClock(repository, time.Now)
}

// NewCredentialStoreWithClock uses an injected clock for deterministic expiry tests.
func NewCredentialStoreWithClock(repository CredentialRepository, now func() time.Time) (*CredentialStore, error) {
	if repository == nil {
		return nil, errors.New("mcp credential repository is required")
	}
	if now == nil {
		return nil, errors.New("mcp credential clock is required")
	}
	return &CredentialStore{repository: repository, now: now}, nil
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
	var expires *string
	if normalized.ExpiresAt != nil {
		expires = new(formatTime(*normalized.ExpiresAt))
	}
	if err := s.repository.CreateCredential(ctx, store.MCPCredentialRecord{
		ID: id, TokenIdentifier: tokenIdentifier, TokenVerifier: verifier, Name: normalized.Name,
		PermissionsJSON: string(permissions), MediaScopeJSON: string(mediaScope), ProjectScopeJSON: string(projectScope),
		ExpiresAt: expires, UnattendedExports: boolInt(normalized.UnattendedExports), CreatedAt: createdText, UpdatedAt: createdText,
	}); err != nil {
		return CreatedCredential{}, err
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
	records, err := s.repository.ListCredentials(ctx, cursor, limit+1)
	if err != nil {
		return nil, nil, err
	}
	credentials := make([]Credential, 0, min(len(records), limit))
	for _, storageRecord := range records {
		record, err := credentialFromStorageRecord(storageRecord)
		if err != nil {
			return nil, nil, err
		}
		if len(credentials) == limit {
			next := credentials[len(credentials)-1].ID
			return credentials, new(next), nil
		}
		credentials = append(credentials, record.Credential)
	}
	return credentials, nil, nil
}

// GrantProject adds one newly created project to a selected scope without
// changing the credential's media scope. An all-project scope needs no change.
func (s *CredentialStore) GrantProject(ctx context.Context, credentialID, projectID string) (Credential, error) {
	if !validCredentialID(credentialID) || !validSafeIdentifier(projectID) {
		return Credential{}, ErrCredentialNotFound
	}
	now := s.currentTime()
	storageRecord, err := s.repository.UpdateCredentialProjectScope(ctx, credentialID, formatTime(now), func(storageRecord store.MCPCredentialRecord) (store.MCPProjectScopeUpdate, error) {
		return s.projectGrant(storageRecord, projectID, now)
	})
	if errors.Is(err, store.ErrMCPCredentialNotFound) {
		return Credential{}, ErrCredentialNotFound
	}
	if errors.Is(err, store.ErrMCPCredentialInactive) {
		return Credential{}, ErrCredentialUnauthorized
	}
	if err != nil {
		return Credential{}, err
	}
	credential, err := credentialFromStorageRecord(storageRecord)
	if err != nil {
		return Credential{}, err
	}
	return cloneCredential(credential.Credential), nil
}

func (s *CredentialStore) CreateProjectAndGrant(ctx context.Context, project store.ProjectRecord, credentialID string) (store.ProjectRecord, Credential, error) {
	if !validCredentialID(credentialID) || !validSafeIdentifier(project.ID) {
		return store.ProjectRecord{}, Credential{}, ErrCredentialNotFound
	}
	now := s.currentTime()
	projectID := project.ID
	projectRecord, credentialRecord, err := s.repository.CreateProjectAndGrant(ctx, project, credentialID, formatTime(now), func(storageRecord store.MCPCredentialRecord) (store.MCPProjectScopeUpdate, error) {
		return s.projectGrant(storageRecord, projectID, now)
	})
	if errors.Is(err, store.ErrMCPCredentialNotFound) {
		return store.ProjectRecord{}, Credential{}, ErrCredentialNotFound
	}
	if errors.Is(err, store.ErrMCPCredentialInactive) {
		return store.ProjectRecord{}, Credential{}, ErrCredentialUnauthorized
	}
	if err != nil {
		return store.ProjectRecord{}, Credential{}, err
	}
	credential, err := credentialFromStorageRecord(credentialRecord)
	if err != nil {
		return store.ProjectRecord{}, Credential{}, err
	}
	return projectRecord, cloneCredential(credential.Credential), nil
}

func (s *CredentialStore) projectGrant(storageRecord store.MCPCredentialRecord, projectID string, now time.Time) (store.MCPProjectScopeUpdate, error) {
	record, err := credentialFromStorageRecord(storageRecord)
	if err != nil {
		return store.MCPProjectScopeUpdate{}, err
	}
	if err := record.activeAt(now); err != nil {
		return store.MCPProjectScopeUpdate{}, err
	}
	if record.ProjectScope.Kind == ProjectScopeAll || slices.Contains(record.ProjectScope.ProjectIDs, projectID) {
		return store.MCPProjectScopeUpdate{}, nil
	}
	if len(record.ProjectScope.ProjectIDs) >= scopeIDLimit {
		return store.MCPProjectScopeUpdate{}, ErrCredentialInvalid
	}
	record.ProjectScope.ProjectIDs = append(record.ProjectScope.ProjectIDs, projectID)
	slices.Sort(record.ProjectScope.ProjectIDs)
	scope, err := json.Marshal(record.ProjectScope)
	if err != nil {
		return store.MCPProjectScopeUpdate{}, err
	}
	return store.MCPProjectScopeUpdate{ProjectScopeJSON: string(scope), Changed: true}, nil
}

// Revoke marks a credential revoked. It is idempotent and cannot be reversed.
func (s *CredentialStore) Revoke(ctx context.Context, id string) (Credential, error) {
	if !validCredentialID(id) {
		return Credential{}, ErrCredentialNotFound
	}
	storageRecord, err := s.repository.RevokeCredential(ctx, id, formatTime(s.currentTime()))
	if errors.Is(err, store.ErrMCPCredentialNotFound) {
		return Credential{}, ErrCredentialNotFound
	}
	if err != nil {
		return Credential{}, err
	}
	record, err := credentialFromStorageRecord(storageRecord)
	if err != nil {
		return Credential{}, err
	}
	return cloneCredential(record.Credential), nil
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
	storageRecord, updated, err := s.repository.TouchCredential(ctx, id, formatTime(now))
	if errors.Is(err, store.ErrMCPCredentialNotFound) {
		return Credential{}, ErrCredentialNotFound
	}
	if err != nil {
		return Credential{}, err
	}
	if !updated {
		record, err = credentialFromStorageRecord(storageRecord)
		if err != nil {
			return Credential{}, err
		}
		if statusErr := record.activeAt(s.currentTime()); statusErr != nil {
			return Credential{}, statusErr
		}
	} else {
		record, err = credentialFromStorageRecord(storageRecord)
		if err != nil {
			return Credential{}, err
		}
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
	var jobID *string
	if normalized.JobID != "" {
		jobID = new(normalized.JobID)
	}
	record, err := s.repository.AppendAudit(ctx, store.MCPAuditRecord{
		CredentialID: credentialID, Operation: normalized.Operation, Outcome: normalized.Outcome,
		ResourceIDsJSON: string(resources), JobID: jobID, OccurredAt: formatTime(now),
	}, MaxAuditEntriesPerCredential)
	if errors.Is(err, store.ErrMCPCredentialNotFound) {
		return AuditEntry{}, ErrCredentialNotFound
	}
	if err != nil {
		return AuditEntry{}, err
	}
	return auditEntryFromStorageRecord(record)
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
	records, err := s.repository.ListAudit(ctx, credentialID, beforeID, limit)
	if err != nil {
		return nil, err
	}
	entries := make([]AuditEntry, 0, len(records))
	for _, record := range records {
		entry, err := auditEntryFromStorageRecord(record)
		if err != nil {
			return nil, err
		}
		entries = append(entries, entry)
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
	// Preserve transport order so primary resource IDs remain first in audit records.
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
	storageRecord, err := s.repository.GetCredential(ctx, id)
	if errors.Is(err, store.ErrMCPCredentialNotFound) {
		return credentialRecord{}, ErrCredentialNotFound
	}
	if err != nil {
		return credentialRecord{}, err
	}
	return credentialFromStorageRecord(storageRecord)
}

func (s *CredentialStore) getByTokenIdentifier(ctx context.Context, identifier string) (credentialRecord, error) {
	storageRecord, err := s.repository.GetCredentialByTokenIdentifier(ctx, identifier)
	if errors.Is(err, store.ErrMCPCredentialNotFound) {
		return credentialRecord{}, ErrCredentialNotFound
	}
	if err != nil {
		return credentialRecord{}, err
	}
	return credentialFromStorageRecord(storageRecord)
}

type credentialRecord struct {
	Credential
	tokenVerifier string
}

func credentialFromStorageRecord(storageRecord store.MCPCredentialRecord) (credentialRecord, error) {
	record := credentialRecord{
		Credential:    Credential{ID: storageRecord.ID, TokenIdentifier: storageRecord.TokenIdentifier, Name: storageRecord.Name},
		tokenVerifier: storageRecord.TokenVerifier,
	}
	var projectScope ProjectScope
	if !validCredentialID(record.ID) || !strings.HasPrefix(record.TokenIdentifier, "t_") || !validSafeIdentifier(record.TokenIdentifier) || len(record.tokenVerifier) != sha256.Size*2 {
		return credentialRecord{}, ErrCredentialData
	}
	if _, err := hex.DecodeString(record.tokenVerifier); err != nil {
		return credentialRecord{}, ErrCredentialData
	}
	if err := decodeJSON(storageRecord.PermissionsJSON, &record.Permissions); err != nil {
		return credentialRecord{}, fmt.Errorf("%w: permissions", ErrCredentialData)
	}
	if err := decodeJSON(storageRecord.MediaScopeJSON, &record.MediaScope); err != nil {
		return credentialRecord{}, fmt.Errorf("%w: media scope", ErrCredentialData)
	}
	if err := decodeJSON(storageRecord.ProjectScopeJSON, &projectScope); err != nil {
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
	if !validCredentialName(record.Name) || storageRecord.UnattendedExports != 0 && storageRecord.UnattendedExports != 1 {
		return credentialRecord{}, ErrCredentialData
	}
	record.UnattendedExports = storageRecord.UnattendedExports == 1
	var err error
	if record.CreatedAt, err = parseTime(storageRecord.CreatedAt); err != nil {
		return credentialRecord{}, fmt.Errorf("%w: created time", ErrCredentialData)
	}
	if _, err = parseTime(storageRecord.UpdatedAt); err != nil {
		return credentialRecord{}, fmt.Errorf("%w: updated time", ErrCredentialData)
	}
	if storageRecord.ExpiresAt != nil {
		value, err := parseTime(*storageRecord.ExpiresAt)
		if err != nil {
			return credentialRecord{}, fmt.Errorf("%w: expiry", ErrCredentialData)
		}
		record.ExpiresAt = new(value)
	}
	if storageRecord.RevokedAt != nil {
		value, err := parseTime(*storageRecord.RevokedAt)
		if err != nil {
			return credentialRecord{}, fmt.Errorf("%w: revocation", ErrCredentialData)
		}
		record.RevokedAt = new(value)
	}
	if storageRecord.LastUsedAt != nil {
		value, err := parseTime(*storageRecord.LastUsedAt)
		if err != nil {
			return credentialRecord{}, fmt.Errorf("%w: last used", ErrCredentialData)
		}
		record.LastUsedAt = new(value)
	}
	return record, nil
}

func auditEntryFromStorageRecord(record store.MCPAuditRecord) (AuditEntry, error) {
	var entry AuditEntry
	if record.ID < 1 || !validCredentialID(record.CredentialID) || !validAuditAtom(record.Operation) || !validAuditAtom(record.Outcome) || record.JobID != nil && !validSafeIdentifier(*record.JobID) || decodeJSON(record.ResourceIDsJSON, &entry.ResourceIDs) != nil || !validIDList(entry.ResourceIDs) || len(entry.ResourceIDs) > auditResourceLimit {
		return AuditEntry{}, ErrAuditData
	}
	occurredAt, err := parseTime(record.OccurredAt)
	if err != nil {
		return AuditEntry{}, ErrAuditData
	}
	entry.ID, entry.CredentialID, entry.Operation, entry.Outcome = record.ID, record.CredentialID, record.Operation, record.Outcome
	entry.OccurredAt = occurredAt
	if record.JobID != nil {
		entry.JobID = *record.JobID
	}
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

func boolInt(value bool) int {
	if value {
		return 1
	}
	return 0
}

func boundedLimit(value, fallback, maximum int) int {
	if value <= 0 {
		return fallback
	}
	return min(value, maximum)
}
