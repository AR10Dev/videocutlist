package mcp

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
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
	permissions, err := normalizePermissions(record.Permissions)
	if err != nil {
		return credentialRecord{}, fmt.Errorf("%w: permissions", ErrCredentialData)
	}
	record.Permissions = permissions
	mediaScope, err := normalizeMediaScope(record.MediaScope)
	if err != nil {
		return credentialRecord{}, fmt.Errorf("%w: media scope", ErrCredentialData)
	}
	record.MediaScope = mediaScope
	normalizedProjectScope, err := normalizeProjectScope(projectScope)
	if err != nil {
		return credentialRecord{}, fmt.Errorf("%w: project scope", ErrCredentialData)
	}
	record.ProjectScope = normalizedProjectScope
	if !validCredentialName(record.Name) || storageRecord.UnattendedExports != 0 && storageRecord.UnattendedExports != 1 {
		return credentialRecord{}, ErrCredentialData
	}
	record.UnattendedExports = storageRecord.UnattendedExports == 1
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
