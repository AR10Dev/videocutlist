package mcp_test

import (
	"path/filepath"
	"testing"
	"time"

	"videocutlist/internal/db"
	"videocutlist/internal/mcp"
)

func TestCredentialPersistsAcrossDatabaseRestart(t *testing.T) {
	ctx := t.Context()
	path := filepath.Join(t.TempDir(), "videocutlist.db")
	database, err := store.OpenDatabase(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	clock := time.Date(2026, time.January, 2, 3, 4, 5, 0, time.UTC)
	credentials, err := mcp.NewCredentialStoreWithClock(database, func() time.Time { return clock })
	if err != nil {
		t.Fatal(err)
	}
	expires := clock.Add(time.Hour)
	created, err := credentials.Create(ctx, mcp.CredentialInput{
		Name: "restartable", Permissions: []mcp.Permission{mcp.PermissionMediaRead},
		MediaScope:   mcp.MediaScope{Kind: mcp.MediaScopeMedia, MediaIDs: []string{"m_clip"}},
		ProjectScope: mcp.ProjectScope{Kind: mcp.ProjectScopeSelected, ProjectIDs: []string{"p_project"}},
		ExpiresAt:    &expires,
	})
	if err != nil {
		_ = database.Close()
		t.Fatal(err)
	}
	if _, err := credentials.RecordAudit(ctx, created.ID, mcp.AuditInput{Operation: "get_media", Outcome: "allowed", ResourceIDs: []string{"m_clip"}}); err != nil {
		_ = database.Close()
		t.Fatal(err)
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}

	reopened, err := store.OpenDatabase(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = reopened.Close() }()
	restarted, err := mcp.NewCredentialStoreWithClock(reopened, func() time.Time { return clock })
	if err != nil {
		t.Fatal(err)
	}
	metadata, err := restarted.Get(ctx, created.ID)
	if err != nil {
		t.Fatal(err)
	}
	if metadata.MediaScope.Kind != mcp.MediaScopeMedia || len(metadata.MediaScope.MediaIDs) != 1 || metadata.ProjectScope.Kind != mcp.ProjectScopeSelected || len(metadata.ProjectScope.ProjectIDs) != 1 {
		t.Fatalf("persisted scopes = %#v", metadata)
	}
	if _, err := restarted.Authenticate(ctx, created.Secret); err != nil {
		t.Fatal(err)
	}
	entries, err := restarted.ListAudit(ctx, created.ID, 10)
	if err != nil || len(entries) != 1 || entries[0].Operation != "get_media" {
		t.Fatalf("persisted audit = %#v, err=%v", entries, err)
	}
}
