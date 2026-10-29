package mcp

import (
	"context"
	"crypto/subtle"
	"errors"
	"fmt"
	store "videocutlist/internal/db"
)

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
