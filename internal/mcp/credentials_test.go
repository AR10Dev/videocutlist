package mcp_test

import (
	"database/sql"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"videocutlist/internal/db"
	"videocutlist/internal/mcp"
)

func TestCredentialSecretIsOneTimeAndLastUseIsPersisted(t *testing.T) {
	ctx := t.Context()
	database, credentials, clock := newCredentialStore(t)
	now := *clock
	expires := now.Add(time.Hour)
	created, err := credentials.Create(ctx, mcp.CredentialInput{
		Name: "Desktop assistant", Permissions: nil,
		MediaScope:   mcp.MediaScope{Kind: mcp.MediaScopeAll},
		ProjectScope: mcp.ProjectScope{Kind: mcp.ProjectScopeAll}, ExpiresAt: &expires,
	})
	if err != nil {
		t.Fatal(err)
	}
	if created.Secret == "" || len(created.Secret) < 60 || !strings.Contains(created.Secret, created.TokenIdentifier) {
		t.Fatalf("generated secret = %q", created.Secret)
	}
	var verifier string
	if err := database.QueryRowContext(ctx, `SELECT token_verifier FROM mcp_credentials WHERE id = ?`, created.ID).Scan(&verifier); err != nil {
		t.Fatal(err)
	}
	if verifier == "" || verifier == created.Secret || strings.Contains(verifier, created.Secret) {
		t.Fatalf("stored verifier contains plaintext secret: %q", verifier)
	}
	metadata, err := credentials.Get(ctx, created.ID)
	if err != nil {
		t.Fatal(err)
	}
	if metadata.ID != created.ID || metadata.TokenIdentifier != created.TokenIdentifier || metadata.LastUsedAt != nil {
		t.Fatalf("metadata = %#v", metadata)
	}
	encoded, err := json.Marshal(metadata)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), created.Secret) || strings.Contains(string(encoded), "tokenVerifier") {
		t.Fatalf("metadata exposed secret material: %s", encoded)
	}
	authenticated, err := credentials.Authenticate(ctx, created.Secret)
	if err != nil {
		t.Fatal(err)
	}
	if authenticated.ID != created.ID || authenticated.LastUsedAt == nil || !authenticated.LastUsedAt.Equal(now) {
		t.Fatalf("authenticated = %#v", authenticated)
	}
	stored, err := credentials.Get(ctx, created.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.LastUsedAt == nil || !stored.LastUsedAt.Equal(now) {
		t.Fatalf("last-used metadata = %#v", stored)
	}
	if _, err := credentials.Authenticate(ctx, created.Secret+"x"); !errors.Is(err, mcp.ErrCredentialUnauthorized) {
		t.Fatalf("wrong secret error = %v", err)
	}
	if _, err := credentials.Authenticate(ctx, "not-a-token"); !errors.Is(err, mcp.ErrCredentialUnauthorized) {
		t.Fatalf("malformed secret error = %v", err)
	}
}

func TestCredentialValidationRequiresExplicitSecurityChoices(t *testing.T) {
	ctx := t.Context()
	_, credentials, clock := newCredentialStore(t)
	now := *clock
	expires := now.Add(time.Hour)
	base := mcp.CredentialInput{
		Name: "assistant", Permissions: []mcp.Permission{mcp.PermissionProjectsWrite},
		MediaScope: mcp.MediaScope{Kind: mcp.MediaScopeAll}, ProjectScope: mcp.ProjectScope{Kind: mcp.ProjectScopeAll}, ExpiresAt: &expires,
	}
	if _, err := credentials.Create(ctx, base); !errors.Is(err, mcp.ErrCredentialInvalid) {
		t.Fatalf("project-write without project-read error = %v", err)
	}
	base.Permissions = []mcp.Permission{mcp.PermissionMediaRead}
	base.ExpiresAt = nil
	if _, err := credentials.Create(ctx, base); !errors.Is(err, mcp.ErrNonExpiringCredentialNeedsAck) {
		t.Fatalf("unacknowledged non-expiry error = %v", err)
	}
	base.AllowNonExpiring = true
	created, err := credentials.Create(ctx, base)
	if err != nil {
		t.Fatal(err)
	}
	if created.ExpiresAt != nil || !created.ActiveAt(now) {
		t.Fatalf("non-expiring credential = %#v", created)
	}
	invalid := base
	invalid.AllowNonExpiring = false
	invalid.ExpiresAt = &expires
	invalid.Permissions = []mcp.Permission{mcp.PermissionMediaRead, mcp.PermissionMediaRead}
	if _, err := credentials.Create(ctx, invalid); !errors.Is(err, mcp.ErrCredentialInvalid) {
		t.Fatalf("duplicate permission error = %v", err)
	}
	invalid.Permissions = []mcp.Permission{mcp.PermissionMediaRead}
	invalid.MediaScope = mcp.MediaScope{Kind: mcp.MediaScopeRoots, RootIDs: []string{"/srv/media"}}
	if _, err := credentials.Create(ctx, invalid); !errors.Is(err, mcp.ErrCredentialInvalid) {
		t.Fatalf("path root scope error = %v", err)
	}
	invalid.MediaScope = mcp.MediaScope{Kind: mcp.MediaScopeAll, MediaIDs: []string{"m_item"}}
	if _, err := credentials.Create(ctx, invalid); !errors.Is(err, mcp.ErrCredentialInvalid) {
		t.Fatalf("mixed all-media scope error = %v", err)
	}
	past := now.Add(-time.Second)
	invalid.MediaScope = mcp.MediaScope{Kind: mcp.MediaScopeAll}
	invalid.ExpiresAt = &past
	if _, err := credentials.Create(ctx, invalid); !errors.Is(err, mcp.ErrCredentialExpired) {
		t.Fatalf("past expiry error = %v", err)
	}
}

func TestCredentialScopesIntersectProjectAndMediaAccess(t *testing.T) {
	credential := mcp.Credential{
		Permissions:  []mcp.Permission{mcp.PermissionMediaRead, mcp.PermissionProjectsRead, mcp.PermissionProjectsWrite, mcp.PermissionExportsPrepare},
		MediaScope:   mcp.MediaScope{Kind: mcp.MediaScopeRoots, RootIDs: []string{"camera"}},
		ProjectScope: mcp.ProjectScope{Kind: mcp.ProjectScopeSelected, ProjectIDs: []string{"p_allowed"}},
	}
	if !credential.AllowsMedia("m_camera", "camera") || credential.AllowsMedia("m_other", "other") {
		t.Fatal("root media scope was not enforced")
	}
	if !credential.AllowsProjectSummary("p_allowed") || credential.AllowsProjectSummary("p_other") {
		t.Fatal("project scope was not enforced")
	}
	allowed := []mcp.MediaResource{{ID: "m_camera", RootID: "camera"}}
	if !credential.AllowsProject("p_allowed", allowed) {
		t.Fatal("authorized full project was denied")
	}
	outOfScope := append(allowed, mcp.MediaResource{ID: "m_other", RootID: "other"})
	if credential.AllowsProject("p_allowed", outOfScope) {
		t.Fatal("project bypassed media scope")
	}
	if credential.Allows(mcp.PermissionProjectsRead, mcp.Resource{ProjectID: "p_allowed", ProjectSummary: true}) == false {
		t.Fatal("project summary was denied")
	}
	if credential.Allows(mcp.PermissionProjectsRead, mcp.Resource{ProjectID: "p_allowed", ProjectMedia: outOfScope}) {
		t.Fatal("out-of-scope full project was allowed")
	}
	if credential.AllowsCreateProject(allowed) == false || credential.AllowsCreateProject(outOfScope) {
		t.Fatal("project creation did not intersect media scope")
	}
	if credential.Allows(mcp.PermissionExportsPrepare, mcp.Resource{ProjectID: "p_allowed", ProjectMedia: allowed}) == false {
		t.Fatal("authorized export was denied")
	}
	if credential.Allows(mcp.PermissionExportsPrepare, mcp.Resource{ProjectID: "p_allowed", ProjectMedia: nil}) {
		t.Fatal("incomplete project was allowed for export")
	}
	if credential.Allows(mcp.PermissionMediaRead, mcp.Resource{MediaID: "m_camera", RootID: "camera"}) == false {
		t.Fatal("authorized media was denied")
	}
	if credential.Allows(mcp.PermissionMediaRead, mcp.Resource{MediaID: "m_camera", RootID: "/srv/media"}) {
		t.Fatal("unsafe root identifier was accepted")
	}
}

func TestCredentialExpiryAndRevocationInvalidateSessions(t *testing.T) {
	ctx := t.Context()
	_, credentials, clock := newCredentialStore(t)
	now := *clock
	expires := now.Add(time.Minute)
	created, err := credentials.Create(ctx, mcp.CredentialInput{
		Name: "temporary", Permissions: []mcp.Permission{mcp.PermissionMediaRead},
		MediaScope: mcp.MediaScope{Kind: mcp.MediaScopeAll}, ProjectScope: mcp.ProjectScope{Kind: mcp.ProjectScopeAll}, ExpiresAt: &expires,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := credentials.Authorize(ctx, created.Secret, mcp.PermissionMediaRead, mcp.Resource{MediaID: "m_clip"}); err != nil {
		t.Fatal(err)
	}
	*clock = clock.Add(2 * time.Minute)
	if _, err := credentials.GetActive(ctx, created.ID); !errors.Is(err, mcp.ErrCredentialExpired) {
		t.Fatalf("expired session error = %v", err)
	}
	if _, err := credentials.Authenticate(ctx, created.Secret); !errors.Is(err, mcp.ErrCredentialExpired) || !errors.Is(err, mcp.ErrCredentialUnauthorized) {
		t.Fatalf("expired authentication error = %v", err)
	}
	// Revoke a newly issued credential and ensure an already-known ID cannot be reused.
	*clock = clock.Add(time.Minute)
	newExpires := clock.Add(time.Hour)
	created, err = credentials.Create(ctx, mcp.CredentialInput{
		Name: "revoked", Permissions: []mcp.Permission{mcp.PermissionMediaRead},
		MediaScope: mcp.MediaScope{Kind: mcp.MediaScopeAll}, ProjectScope: mcp.ProjectScope{Kind: mcp.ProjectScopeAll}, ExpiresAt: &newExpires,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := credentials.AuthorizeCredential(ctx, created.ID, mcp.PermissionMediaRead, mcp.Resource{MediaID: "m_clip"}); err != nil {
		t.Fatal(err)
	}
	if _, err := credentials.Revoke(ctx, created.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := credentials.Authenticate(ctx, created.Secret); !errors.Is(err, mcp.ErrCredentialRevoked) || !errors.Is(err, mcp.ErrCredentialUnauthorized) {
		t.Fatalf("revoked authentication error = %v", err)
	}
	if _, err := credentials.AuthorizeCredential(ctx, created.ID, mcp.PermissionMediaRead, mcp.Resource{MediaID: "m_clip"}); !errors.Is(err, mcp.ErrCredentialUnauthorized) {
		t.Fatalf("revoked session error = %v", err)
	}
	if _, err := credentials.Revoke(ctx, created.ID); err != nil {
		t.Fatalf("idempotent revoke error = %v", err)
	}
}

func TestAuditIsSafeAndBoundedPerCredential(t *testing.T) {
	ctx := t.Context()
	database, credentials, clock := newCredentialStore(t)
	now := *clock
	expires := now.Add(time.Hour)
	created, err := credentials.Create(ctx, mcp.CredentialInput{
		Name: "audited", Permissions: []mcp.Permission{mcp.PermissionMediaRead},
		MediaScope: mcp.MediaScope{Kind: mcp.MediaScopeAll}, ProjectScope: mcp.ProjectScope{Kind: mcp.ProjectScopeAll}, ExpiresAt: &expires,
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, input := range []mcp.AuditInput{
		{Operation: "get_media", Outcome: "allowed", ResourceIDs: []string{"m_media", "p_project"}, JobID: "j_job"},
		{Operation: "get_media", Outcome: "denied", ResourceIDs: []string{"/srv/source"}},
		{Operation: "get_media", Outcome: "denied", ResourceIDs: []string{"m_media", "m_media"}},
		{Operation: "raw content", Outcome: "denied"},
	} {
		if _, err := credentials.RecordAudit(ctx, created.ID, input); !errors.Is(err, mcp.ErrAuditInvalid) {
			if input.Outcome == "allowed" {
				continue
			}
			t.Fatalf("unsafe audit input %#v error = %v", input, err)
		}
	}
	first, err := credentials.ListAudit(ctx, created.ID, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(first) != 1 || !reflect.DeepEqual(first[0].ResourceIDs, []string{"m_media", "p_project"}) || first[0].JobID != "j_job" {
		t.Fatalf("safe audit entries = %#v", first)
	}
	for i := 0; i < mcp.MaxAuditEntriesPerCredential+3; i++ {
		if _, err := credentials.RecordAudit(ctx, created.ID, mcp.AuditInput{Operation: "job_status", Outcome: "allowed", ResourceIDs: []string{"j_item"}}); err != nil {
			t.Fatal(err)
		}
	}
	var count int
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM mcp_audit_entries WHERE credential_id = ?`, created.ID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != mcp.MaxAuditEntriesPerCredential {
		t.Fatalf("audit count = %d, want %d", count, mcp.MaxAuditEntriesPerCredential)
	}
	entries, err := credentials.ListAudit(ctx, created.ID, mcp.MaxAuditEntriesPerCredential+100)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 100 || entries[0].ID <= entries[len(entries)-1].ID {
		t.Fatalf("bounded audit page = %d entries=%#v", len(entries), entries[:min(len(entries), 2)])
	}
	var raw string
	if err := database.QueryRowContext(ctx, `SELECT operation || outcome || resource_ids_json || COALESCE(job_id, '') FROM mcp_audit_entries WHERE credential_id = ? LIMIT 1`, created.ID).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(raw, "/srv/source") || strings.Contains(raw, "raw content") {
		t.Fatalf("unsafe audit value persisted: %q", raw)
	}
	before := entries[0].ID
	older, err := credentials.ListAuditBefore(ctx, created.ID, before, 1)
	if err != nil || len(older) != 1 {
		t.Fatalf("audit cursor entries=%#v err=%v", older, err)
	}
}

func newCredentialStore(t *testing.T) (*sql.DB, *mcp.CredentialStore, *time.Time) {
	t.Helper()
	ctx := t.Context()
	database, err := store.OpenDatabase(ctx, t.TempDir()+"/credentials.db")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	now := time.Date(2026, time.January, 2, 3, 4, 5, 0, time.UTC)
	current := now
	credentials, err := mcp.NewCredentialStoreWithClock(database, func() time.Time { return current })
	if err != nil {
		t.Fatal(err)
	}
	return database, credentials, &current
}
