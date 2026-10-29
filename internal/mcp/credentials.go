// Package mcp contains the credential and authorization domain used by the
// Streamable HTTP adapter. Deployment authentication remains the administrative
// boundary; these credentials are scoped assistant credentials only.
package mcp

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"slices"
	"time"
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
