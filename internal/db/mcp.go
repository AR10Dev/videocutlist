package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
)

var (
	ErrMCPCredentialNotFound = errors.New("mcp credential not found")
	ErrMCPProposalNotFound   = errors.New("mcp proposal not found")
	ErrMCPCredentialInactive = errors.New("mcp credential is no longer active")
)

// MCPCredentialRecord is the database representation of an MCP credential.
// Its JSON and verifier fields are storage data, not application responses.
type MCPCredentialRecord struct {
	ID                string
	TokenIdentifier   string
	TokenVerifier     string
	Name              string
	PermissionsJSON   string
	MediaScopeJSON    string
	ProjectScopeJSON  string
	ExpiresAt         *string
	RevokedAt         *string
	UnattendedExports int
	CreatedAt         string
	LastUsedAt        *string
	UpdatedAt         string
}

// MCPProjectScopeUpdate carries a proposed application-calculated project scope.
type MCPProjectScopeUpdate struct {
	ProjectScopeJSON string
	Changed          bool
}

// MCPAuditRecord contains persisted MCP audit data, including encoded resource IDs.
type MCPAuditRecord struct {
	ID              int64
	CredentialID    string
	Operation       string
	Outcome         string
	ResourceIDsJSON string
	JobID           *string
	OccurredAt      string
}

// MCPProposalRecord contains the persisted proposal document and transition fields.
type MCPProposalRecord struct {
	ID                 string
	CredentialID       string
	ProjectID          *string
	ProjectRevision    int64
	PayloadJSON        string
	FindingsJSON       string
	RequiresReencoding int
	Accuracy           string
	DestinationID      string
	ExpiresAt          string
	ApprovedAt         *string
	CreatedAt          string
}

// MCPProposalPageEntry is an ordered cursor row for pending proposal selection.
type MCPProposalPageEntry struct {
	ID        string
	CreatedAt string
}

// MCPStorage owns MCP credential, audit, proposal, and project-plus-grant SQL.
type MCPStorage struct {
	db       *sql.DB
	projects *ProjectStore
}

// NewMCPStorage constructs MCP persistence over an already migrated database.
func NewMCPStorage(db *sql.DB) (*MCPStorage, error) {
	if db == nil {
		return nil, errors.New("mcp database is required")
	}
	projects, err := NewProjectStore(db)
	if err != nil {
		return nil, err
	}
	return &MCPStorage{db: db, projects: projects}, nil
}

func (s *MCPStorage) CreateCredential(ctx context.Context, record MCPCredentialRecord) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO mcp_credentials
(id, token_identifier, token_verifier, name, permissions_json, media_scope_json, project_scope_json, expires_at, revoked_at, unattended_exports, created_at, last_used_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, ?)`,
		record.ID, record.TokenIdentifier, record.TokenVerifier, record.Name,
		record.PermissionsJSON, record.MediaScopeJSON, record.ProjectScopeJSON,
		record.ExpiresAt, record.UnattendedExports, record.CreatedAt, record.UpdatedAt)
	if err != nil {
		return fmt.Errorf("create mcp credential: %w", err)
	}
	return nil
}

func (s *MCPStorage) GetCredential(ctx context.Context, id string) (MCPCredentialRecord, error) {
	record, err := scanMCPCredential(s.db.QueryRowContext(ctx, mcpCredentialSelect+` WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return MCPCredentialRecord{}, ErrMCPCredentialNotFound
	}
	return record, err
}

func (s *MCPStorage) GetCredentialByTokenIdentifier(ctx context.Context, identifier string) (MCPCredentialRecord, error) {
	record, err := scanMCPCredential(s.db.QueryRowContext(ctx, mcpCredentialSelect+` WHERE token_identifier = ?`, identifier))
	if errors.Is(err, sql.ErrNoRows) {
		return MCPCredentialRecord{}, ErrMCPCredentialNotFound
	}
	return record, err
}

func (s *MCPStorage) ListCredentials(ctx context.Context, cursor string, limit int) ([]MCPCredentialRecord, error) {
	rows, err := s.db.QueryContext(ctx, mcpCredentialSelect+` WHERE id > ? ORDER BY id LIMIT ?`, cursor, limit)
	if err != nil {
		return nil, fmt.Errorf("list mcp credentials: %w", err)
	}
	defer func() { _ = rows.Close() }()
	records := make([]MCPCredentialRecord, 0, limit)
	for rows.Next() {
		record, err := scanMCPCredential(rows)
		if err != nil {
			return nil, err
		}
		records = append(records, record)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return records, nil
}

func (s *MCPStorage) RevokeCredential(ctx context.Context, id, now string) (record MCPCredentialRecord, err error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return MCPCredentialRecord{}, fmt.Errorf("begin mcp credential revocation: %w", err)
	}
	defer rollbackMCP(tx, "rollback mcp credential revocation", &err)
	result, err := tx.ExecContext(ctx, `UPDATE mcp_credentials
SET revoked_at = COALESCE(revoked_at, ?), updated_at = ? WHERE id = ?`, now, now, id)
	if err != nil {
		return MCPCredentialRecord{}, fmt.Errorf("revoke mcp credential: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return MCPCredentialRecord{}, err
	}
	if affected == 0 {
		return MCPCredentialRecord{}, ErrMCPCredentialNotFound
	}
	record, err = getMCPCredentialTx(ctx, tx, id)
	if err != nil {
		return MCPCredentialRecord{}, err
	}
	if err := tx.Commit(); err != nil {
		return MCPCredentialRecord{}, fmt.Errorf("commit mcp credential revocation: %w", err)
	}
	return record, nil
}

func (s *MCPStorage) TouchCredential(ctx context.Context, id, now string) (record MCPCredentialRecord, updated bool, err error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return MCPCredentialRecord{}, false, fmt.Errorf("begin mcp credential usage update: %w", err)
	}
	defer rollbackMCP(tx, "rollback mcp credential usage update", &err)
	result, err := tx.ExecContext(ctx, `UPDATE mcp_credentials
SET last_used_at = ?, updated_at = ?
WHERE id = ? AND revoked_at IS NULL`, now, now, id)
	if err != nil {
		return MCPCredentialRecord{}, false, fmt.Errorf("update mcp credential usage: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return MCPCredentialRecord{}, false, err
	}
	record, err = getMCPCredentialTx(ctx, tx, id)
	if err != nil {
		return MCPCredentialRecord{}, false, err
	}
	if err := tx.Commit(); err != nil {
		return MCPCredentialRecord{}, false, fmt.Errorf("commit mcp credential usage update: %w", err)
	}
	return record, affected == 1, nil
}

func (s *MCPStorage) UpdateCredentialProjectScope(ctx context.Context, id, now string, decide func(MCPCredentialRecord) (MCPProjectScopeUpdate, error)) (record MCPCredentialRecord, err error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return MCPCredentialRecord{}, fmt.Errorf("begin mcp project grant: %w", err)
	}
	defer rollbackMCP(tx, "rollback mcp project grant", &err)
	record, err = updateProjectScopeTx(ctx, tx, id, now, decide)
	if err != nil {
		return MCPCredentialRecord{}, err
	}
	if err := tx.Commit(); err != nil {
		return MCPCredentialRecord{}, fmt.Errorf("commit mcp project grant: %w", err)
	}
	return record, nil
}

func (s *MCPStorage) CreateProjectAndGrant(ctx context.Context, project ProjectRecord, credentialID, now string, decide func(MCPCredentialRecord) (MCPProjectScopeUpdate, error)) (created ProjectRecord, credential MCPCredentialRecord, err error) {
	if project.ID == "" || project.Revision != 0 {
		return ProjectRecord{}, MCPCredentialRecord{}, errors.New("new project ID and zero revision are required")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return ProjectRecord{}, MCPCredentialRecord{}, fmt.Errorf("begin mcp project creation: %w", err)
	}
	defer rollbackMCP(tx, "rollback mcp project creation", &err)
	created, err = s.projects.SaveTx(ctx, tx, project.ID, 0, project.DocumentJSON)
	if err != nil {
		return ProjectRecord{}, MCPCredentialRecord{}, err
	}
	credential, err = updateProjectScopeTx(ctx, tx, credentialID, now, decide)
	if err != nil {
		return ProjectRecord{}, MCPCredentialRecord{}, err
	}
	if err := tx.Commit(); err != nil {
		return ProjectRecord{}, MCPCredentialRecord{}, fmt.Errorf("commit mcp project creation and grant: %w", err)
	}
	return created, credential, nil
}

func (s *MCPStorage) AppendAudit(ctx context.Context, entry MCPAuditRecord, maximum int) (resultRecord MCPAuditRecord, err error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return MCPAuditRecord{}, fmt.Errorf("begin mcp audit: %w", err)
	}
	defer rollbackMCP(tx, "rollback mcp audit", &err)
	var exists int
	if err := tx.QueryRowContext(ctx, `SELECT 1 FROM mcp_credentials WHERE id = ?`, entry.CredentialID).Scan(&exists); errors.Is(err, sql.ErrNoRows) {
		return MCPAuditRecord{}, ErrMCPCredentialNotFound
	} else if err != nil {
		return MCPAuditRecord{}, fmt.Errorf("check mcp credential for audit: %w", err)
	}
	result, err := tx.ExecContext(ctx, `INSERT INTO mcp_audit_entries
(credential_id, operation, outcome, resource_ids_json, job_id, occurred_at)
VALUES (?, ?, ?, ?, ?, ?)`, entry.CredentialID, entry.Operation, entry.Outcome, entry.ResourceIDsJSON, entry.JobID, entry.OccurredAt)
	if err != nil {
		return MCPAuditRecord{}, fmt.Errorf("record mcp audit: %w", err)
	}
	entry.ID, err = result.LastInsertId()
	if err != nil {
		return MCPAuditRecord{}, err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM mcp_audit_entries
WHERE credential_id = ? AND id IN (
  SELECT id FROM mcp_audit_entries WHERE credential_id = ?
  ORDER BY id DESC LIMIT -1 OFFSET ?
)`, entry.CredentialID, entry.CredentialID, maximum); err != nil {
		return MCPAuditRecord{}, fmt.Errorf("bound mcp audit: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return MCPAuditRecord{}, fmt.Errorf("commit mcp audit: %w", err)
	}
	return entry, nil
}

func (s *MCPStorage) ListAudit(ctx context.Context, credentialID string, beforeID int64, limit int) ([]MCPAuditRecord, error) {
	query := `SELECT id, credential_id, operation, outcome, resource_ids_json, job_id, occurred_at
FROM mcp_audit_entries WHERE credential_id = ?`
	args := []any{credentialID}
	if beforeID != 0 {
		query += ` AND id < ?`
		args = append(args, beforeID)
	}
	query += ` ORDER BY id DESC LIMIT ?`
	args = append(args, limit)
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("list mcp audit: %w", err)
	}
	defer func() { _ = rows.Close() }()
	entries := make([]MCPAuditRecord, 0, limit)
	for rows.Next() {
		entry, err := scanMCPAudit(rows)
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

func (s *MCPStorage) InsertProposal(ctx context.Context, proposal MCPProposalRecord) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO export_proposals
(id, credential_id, project_id, project_revision, payload_json, findings_json, requires_reencoding, accuracy, destination_id, expires_at, created_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		proposal.ID, proposal.CredentialID, proposal.ProjectID, proposal.ProjectRevision,
		proposal.PayloadJSON, proposal.FindingsJSON, proposal.RequiresReencoding, proposal.Accuracy,
		proposal.DestinationID, proposal.ExpiresAt, proposal.CreatedAt)
	if err != nil {
		return fmt.Errorf("insert export proposal: %w", err)
	}
	return nil
}

func (s *MCPStorage) GetProposal(ctx context.Context, id string) (MCPProposalRecord, error) {
	proposal, err := scanMCPProposal(s.db.QueryRowContext(ctx, mcpProposalSelect+` WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return MCPProposalRecord{}, ErrMCPProposalNotFound
	}
	return proposal, err
}

func (s *MCPStorage) ListPendingProposals(ctx context.Context, now, cursorCreatedAt, cursorID string, limit int) ([]MCPProposalPageEntry, error) {
	query := `SELECT id, created_at FROM export_proposals WHERE approved_at IS NULL AND expires_at > ?`
	args := []any{now}
	if cursorID != "" {
		query += ` AND (created_at < ? OR (created_at = ? AND id < ?))`
		args = append(args, cursorCreatedAt, cursorCreatedAt, cursorID)
	}
	query += ` ORDER BY created_at DESC, id DESC LIMIT ?`
	args = append(args, limit)
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("list pending export proposals: %w", err)
	}
	defer func() { _ = rows.Close() }()
	entries := make([]MCPProposalPageEntry, 0, limit)
	for rows.Next() {
		var entry MCPProposalPageEntry
		if err := rows.Scan(&entry.ID, &entry.CreatedAt); err != nil {
			return nil, err
		}
		entries = append(entries, entry)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return entries, nil
}

func (s *MCPStorage) ApproveProposal(ctx context.Context, id, now string) (proposal MCPProposalRecord, approved bool, err error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return MCPProposalRecord{}, false, fmt.Errorf("begin export proposal approval: %w", err)
	}
	defer rollbackMCP(tx, "rollback export proposal approval", &err)
	result, err := tx.ExecContext(ctx, `UPDATE export_proposals
SET approved_at = COALESCE(approved_at, ?)
WHERE id = ? AND expires_at > ?`, now, id, now)
	if err != nil {
		return MCPProposalRecord{}, false, fmt.Errorf("approve export proposal: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return MCPProposalRecord{}, false, err
	}
	if affected != 1 {
		if err := tx.Commit(); err != nil {
			return MCPProposalRecord{}, false, fmt.Errorf("finish expired proposal approval: %w", err)
		}
		return MCPProposalRecord{}, false, nil
	}
	proposal, err = getMCPProposalTx(ctx, tx, id)
	if err != nil {
		return MCPProposalRecord{}, false, err
	}
	if err := tx.Commit(); err != nil {
		return MCPProposalRecord{}, false, fmt.Errorf("commit export proposal approval: %w", err)
	}
	return proposal, true, nil
}

const mcpCredentialSelect = `SELECT id, token_identifier, token_verifier, name, permissions_json, media_scope_json, project_scope_json,
expires_at, revoked_at, unattended_exports, created_at, last_used_at, updated_at FROM mcp_credentials`

const mcpProposalSelect = `SELECT id, credential_id, project_id, project_revision, payload_json, findings_json, requires_reencoding,
accuracy, destination_id, expires_at, approved_at, created_at FROM export_proposals`

type mcpScanner interface {
	Scan(...any) error
}

func scanMCPCredential(row mcpScanner) (MCPCredentialRecord, error) {
	var record MCPCredentialRecord
	var expires, revoked, lastUsed sql.NullString
	if err := row.Scan(&record.ID, &record.TokenIdentifier, &record.TokenVerifier, &record.Name,
		&record.PermissionsJSON, &record.MediaScopeJSON, &record.ProjectScopeJSON,
		&expires, &revoked, &record.UnattendedExports, &record.CreatedAt, &lastUsed, &record.UpdatedAt); err != nil {
		return MCPCredentialRecord{}, err
	}
	record.ExpiresAt = nullableStringPointer(expires)
	record.RevokedAt = nullableStringPointer(revoked)
	record.LastUsedAt = nullableStringPointer(lastUsed)
	return record, nil
}

func scanMCPAudit(row mcpScanner) (MCPAuditRecord, error) {
	var entry MCPAuditRecord
	var jobID sql.NullString
	if err := row.Scan(&entry.ID, &entry.CredentialID, &entry.Operation, &entry.Outcome, &entry.ResourceIDsJSON, &jobID, &entry.OccurredAt); err != nil {
		return MCPAuditRecord{}, err
	}
	entry.JobID = nullableStringPointer(jobID)
	return entry, nil
}

func scanMCPProposal(row mcpScanner) (MCPProposalRecord, error) {
	var proposal MCPProposalRecord
	var projectID, approved sql.NullString
	if err := row.Scan(&proposal.ID, &proposal.CredentialID, &projectID, &proposal.ProjectRevision,
		&proposal.PayloadJSON, &proposal.FindingsJSON, &proposal.RequiresReencoding,
		&proposal.Accuracy, &proposal.DestinationID, &proposal.ExpiresAt, &approved, &proposal.CreatedAt); err != nil {
		return MCPProposalRecord{}, err
	}
	proposal.ProjectID = nullableStringPointer(projectID)
	proposal.ApprovedAt = nullableStringPointer(approved)
	return proposal, nil
}

func nullableStringPointer(value sql.NullString) *string {
	if !value.Valid {
		return nil
	}
	return &value.String
}

func getMCPCredentialTx(ctx context.Context, tx *sql.Tx, id string) (MCPCredentialRecord, error) {
	record, err := scanMCPCredential(tx.QueryRowContext(ctx, mcpCredentialSelect+` WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return MCPCredentialRecord{}, ErrMCPCredentialNotFound
	}
	return record, err
}

func updateProjectScopeTx(ctx context.Context, tx *sql.Tx, id, now string, decide func(MCPCredentialRecord) (MCPProjectScopeUpdate, error)) (MCPCredentialRecord, error) {
	record, err := getMCPCredentialTx(ctx, tx, id)
	if err != nil {
		return MCPCredentialRecord{}, err
	}
	update, err := decide(record)
	if err != nil {
		return MCPCredentialRecord{}, err
	}
	if update.Changed {
		result, err := tx.ExecContext(ctx, `UPDATE mcp_credentials SET project_scope_json = ?, updated_at = ?
WHERE id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`, update.ProjectScopeJSON, now, id, now)
		if err != nil {
			return MCPCredentialRecord{}, fmt.Errorf("grant mcp project: %w", err)
		}
		affected, err := result.RowsAffected()
		if err != nil {
			return MCPCredentialRecord{}, err
		}
		if affected != 1 {
			return MCPCredentialRecord{}, ErrMCPCredentialInactive
		}
		record.ProjectScopeJSON = update.ProjectScopeJSON
		record.UpdatedAt = now
	} else {
		result, err := tx.ExecContext(ctx, `UPDATE mcp_credentials SET updated_at = updated_at
WHERE id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`, id, now)
		if err != nil {
			return MCPCredentialRecord{}, fmt.Errorf("check mcp project grant status: %w", err)
		}
		affected, err := result.RowsAffected()
		if err != nil {
			return MCPCredentialRecord{}, err
		}
		if affected != 1 {
			return MCPCredentialRecord{}, ErrMCPCredentialInactive
		}
	}
	return record, nil
}

func getMCPProposalTx(ctx context.Context, tx *sql.Tx, id string) (MCPProposalRecord, error) {
	proposal, err := scanMCPProposal(tx.QueryRowContext(ctx, mcpProposalSelect+` WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return MCPProposalRecord{}, ErrMCPProposalNotFound
	}
	return proposal, err
}

func rollbackMCP(tx *sql.Tx, operation string, err *error) {
	if rollbackErr := tx.Rollback(); rollbackErr != nil && !errors.Is(rollbackErr, sql.ErrTxDone) {
		*err = errors.Join(*err, fmt.Errorf("%s: %w", operation, rollbackErr))
	}
}
