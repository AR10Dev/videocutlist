package mcp

import (
	"errors"
	"path/filepath"
	"testing"
	"time"
	store "videocutlist/internal/db"
)

func TestCredentialLifecycle(t *testing.T) {
	db, err := store.OpenDatabase(t.Context(), filepath.Join(t.TempDir(), "credentials.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	repository, err := store.NewMCPStorage(db)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	credentials, err := NewCredentialStoreWithClock(repository, func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	input := CredentialInput{Name: "Read selected media", Permissions: []Permission{PermissionMediaRead}, MediaScope: MediaScope{Kind: MediaScopeMedia, MediaIDs: []string{"media-1"}}, ProjectScope: ProjectScope{Kind: ProjectScopeAll}}
	if _, err := credentials.Create(t.Context(), input); !errors.Is(err, ErrNonExpiringCredentialNeedsAck) {
		t.Fatalf("missing expiry: %v", err)
	}
	input.ExpiresAt = new(now.Add(time.Hour))
	created, err := credentials.Create(t.Context(), input)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := credentials.Authenticate(t.Context(), created.Secret+"x"); !errors.Is(err, ErrCredentialUnauthorized) {
		t.Fatalf("modified secret: %v", err)
	}
	if _, err := credentials.Authorize(t.Context(), created.Secret, PermissionMediaRead, Resource{MediaID: "media-1"}); err != nil {
		t.Fatal(err)
	}
	if _, err := credentials.Authorize(t.Context(), created.Secret, PermissionMediaRead, Resource{MediaID: "media-2"}); !errors.Is(err, ErrResourceDenied) {
		t.Fatalf("outside scope: %v", err)
	}
	if _, err := credentials.Authorize(t.Context(), created.Secret, PermissionExportsRun, Resource{MediaID: "media-1"}); !errors.Is(err, ErrPermissionDenied) {
		t.Fatalf("ungranted permission: %v", err)
	}
	now = now.Add(time.Hour)
	if _, err := credentials.Authenticate(t.Context(), created.Secret); !errors.Is(err, ErrCredentialExpired) {
		t.Fatalf("expiry boundary: %v", err)
	}
	now = now.Add(-time.Hour)
	if _, err := credentials.Revoke(t.Context(), created.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := credentials.Authenticate(t.Context(), created.Secret); !errors.Is(err, ErrCredentialRevoked) {
		t.Fatalf("revoked: %v", err)
	}
}
