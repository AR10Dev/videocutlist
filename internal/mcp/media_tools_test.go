package mcp_test

import (
	"context"
	"strings"
	"testing"
	"time"

	store "videocutlist/internal/db"
	"videocutlist/internal/mcp"
	"videocutlist/internal/projects"
)

type toolMedia struct{ items []projects.Media }

func (m toolMedia) List(_ context.Context, cursor string, limit int) (projects.MediaPage, error) {
	page := projects.MediaPage{}
	for _, item := range m.items {
		if item.ID > cursor {
			page.Items = append(page.Items, item)
		}
	}
	if len(page.Items) > limit {
		next := page.Items[limit-1].ID
		page.NextCursor = &next
		page.Items = page.Items[:limit]
	}
	return page, nil
}
func (m toolMedia) Get(_ context.Context, id string) (projects.Media, error) {
	for _, item := range m.items {
		if item.ID == id {
			return item, nil
		}
	}
	return projects.Media{}, store.ErrMediaNotFound
}

func TestMediaToolsScopeAndSafeMetadata(t *testing.T) {
	media := toolMedia{items: []projects.Media{
		{ID: "m_alpha", RootID: "camera", Name: "alpha.mp4", DurationMS: 1000, SizeBytes: 4, Container: "mp4", Streams: map[string]any{"video": "h264"}},
		{ID: "m_secret", RootID: "private", Name: "secret.mp4", DurationMS: 2000, SizeBytes: 8, Container: "mp4", Streams: map[string]any{"video": "hevc"}},
	}}
	credentials, secret := scopedTransportCredentials(t)
	handler := newTransport(t, mcp.TransportConfig{Enabled: true, Credentials: credentials, Tools: mcp.MediaTools(media)})
	session := initialize(t, handler, secret)

	list := serve(handler, sessionRequest(`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_media","arguments":{"query":"alpha","limit":1}}}`, secret, session))
	if list.Code != 200 || !contains(list.Body.String(), "m_alpha") || contains(list.Body.String(), "m_secret") || contains(list.Body.String(), "private") {
		t.Fatalf("scoped list=%s", list.Body.String())
	}
	get := serve(handler, sessionRequest(`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_media","arguments":{"id":"m_alpha"}}}`, secret, session))
	if get.Code != 200 || !contains(get.Body.String(), `"durationMs":1000`) || contains(get.Body.String(), "camera") {
		t.Fatalf("safe get=%s", get.Body.String())
	}

	denied := serve(handler, sessionRequest(`{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"get_media","arguments":{"id":"m_secret"}}}`, secret, session))
	missing := serve(handler, sessionRequest(`{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"get_media","arguments":{"id":"m_missing"}}}`, secret, session))
	if !contains(denied.Body.String(), "Tool failed.") || !contains(missing.Body.String(), "Tool failed.") || contains(denied.Body.String(), "private") || contains(denied.Body.String(), "secret.mp4") {
		t.Fatalf("denied=%s missing=%s", denied.Body.String(), missing.Body.String())
	}
}

func TestMediaToolsFinalFilteredPageDoesNotReturnCursor(t *testing.T) {
	media := toolMedia{items: []projects.Media{
		{ID: "m_a_skip", RootID: "camera", Name: "skip.mp4", DurationMS: 1000},
		{ID: "m_b_match", RootID: "camera", Name: "match.mp4", DurationMS: 1000},
	}}
	credentials, secret := scopedTransportCredentials(t)
	handler := newTransport(t, mcp.TransportConfig{Enabled: true, Credentials: credentials, Tools: mcp.MediaTools(media)})
	session := initialize(t, handler, secret)

	response := serve(handler, sessionRequest(`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_media","arguments":{"query":"match","limit":1}}}`, secret, session))
	if response.Code != 200 || !contains(response.Body.String(), "m_b_match") || contains(response.Body.String(), "m_a_skip") {
		t.Fatalf("filtered media page = %s", response.Body.String())
	}
	if contains(response.Body.String(), `"nextCursor"`) {
		t.Fatalf("final filtered media page returned cursor: %s", response.Body.String())
	}
}

func TestMediaToolsRetainsUnconsumedFinalPageRows(t *testing.T) {
	media := toolMedia{items: []projects.Media{
		{ID: "m_a_match", RootID: "camera", Name: "match-a.mp4"},
		{ID: "m_b_match", RootID: "camera", Name: "match-b.mp4"},
	}}
	credentials, secret := scopedTransportCredentials(t)
	handler := newTransport(t, mcp.TransportConfig{Enabled: true, Credentials: credentials, Tools: mcp.MediaTools(media)})
	session := initialize(t, handler, secret)
	first := serve(handler, sessionRequest(`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_media","arguments":{"limit":1}}}`, secret, session))
	if !contains(first.Body.String(), `"nextCursor":"m_a_match"`) || contains(first.Body.String(), "m_b_match") {
		t.Fatalf("first page lost continuation: %s", first.Body.String())
	}
	second := serve(handler, sessionRequest(`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_media","arguments":{"limit":1,"cursor":"m_a_match"}}}`, secret, session))
	if !contains(second.Body.String(), "m_b_match") || contains(second.Body.String(), "m_a_match") || contains(second.Body.String(), `"nextCursor"`) {
		t.Fatalf("second page duplicated or lost rows: %s", second.Body.String())
	}
}

func scopedTransportCredentials(t *testing.T) (*mcp.CredentialStore, string) {
	t.Helper()
	database, err := store.OpenDatabase(t.Context(), t.TempDir()+"/mcp.db")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	credentials, err := mcp.NewCredentialStore(database)
	if err != nil {
		t.Fatal(err)
	}
	expires := time.Now().Add(time.Hour)
	created, err := credentials.Create(t.Context(), mcp.CredentialInput{Name: "scoped", Permissions: []mcp.Permission{mcp.PermissionMediaRead}, MediaScope: mcp.MediaScope{Kind: mcp.MediaScopeRoots, RootIDs: []string{"camera"}}, ProjectScope: mcp.ProjectScope{Kind: mcp.ProjectScopeAll}, ExpiresAt: &expires})
	if err != nil {
		t.Fatal(err)
	}
	return credentials, created.Secret
}

func contains(value, needle string) bool { return strings.Contains(value, needle) }
