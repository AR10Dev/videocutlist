package mcp_test

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"testing"
	"time"

	store "videocutlist/internal/db"
	"videocutlist/internal/mcp"
)

func TestTransportAuditSurvivesCancelledRequestAndBoundsResources(t *testing.T) {
	database, credentials, secret := newAuditTestStore(t)
	resource := mcp.Resource{
		ProjectID: "project_primary", MediaID: "media_primary",
		ProjectMedia: []mcp.MediaResource{{ID: "media_primary", RootID: "/private/root/path"}},
	}
	for i := 1; i < 40; i++ {
		resource.ProjectMedia = append(resource.ProjectMedia, mcp.MediaResource{ID: fmt.Sprintf("media_%02d", i), RootID: fmt.Sprintf("root_%02d", i)})
	}
	cancelRequest := func() {}
	handler := newTransport(t, mcp.TransportConfig{
		Enabled: true, Credentials: credentials,
		Tools: []mcp.Tool{{
			Name: "audit_tool", Permission: mcp.PermissionMediaRead,
			InputSchema: map[string]any{"type": "object"},
			Resource:    func(mcp.Context, json.RawMessage) (mcp.Resource, error) { return resource, nil },
			Call: func(toolContext mcp.Context, _ json.RawMessage) (mcp.ToolResult, error) {
				cancelRequest()
				timer := time.NewTimer(time.Second)
				defer timer.Stop()
				select {
				case <-toolContext.Request.Context().Done():
				case <-timer.C:
					return mcp.ToolResult{}, context.DeadlineExceeded
				}
				return mcp.ToolResult{Content: []mcp.ToolContent{{Type: "text", Text: "complete"}}}, nil
			},
		}},
	})
	session := initialize(t, handler, secret)
	ctx, cancel := context.WithCancel(t.Context())
	cancelRequest = cancel
	call := sessionRequest(`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"audit_tool","arguments":{}}}`, secret, session).WithContext(ctx)
	_ = serve(handler, call)
	cancel()

	credential, err := credentials.Authenticate(t.Context(), secret)
	if err != nil {
		t.Fatal(err)
	}
	entries, err := credentials.ListAudit(t.Context(), credential.ID, 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Outcome != "success" {
		t.Fatalf("audit entries after canceled request = %#v, want one successful audit", entries)
	}
	got := entries[0].ResourceIDs
	if len(got) != 32 || got[0] != resource.ProjectID || got[1] != resource.MediaID || got[2] != "media_01" || got[31] != "root_15" {
		t.Fatalf("canceled-request audit resources = %v", got)
	}
	seen := make(map[string]bool, len(got))
	for _, id := range got {
		if seen[id] || strings.Contains(id, "/") {
			t.Fatalf("canceled-request audit contains duplicate or unsafe ID %q: %v", id, got)
		}
		seen[id] = true
	}
	var count int
	if err := database.QueryRowContext(t.Context(), `SELECT COUNT(*) FROM mcp_audit_entries WHERE credential_id = ?`, credential.ID).Scan(&count); err != nil || count != 1 {
		t.Fatalf("stored audit count = %d, err=%v", count, err)
	}
}

func TestTransportAuditWriteFailureLogsOnlySafeCategory(t *testing.T) {
	database, credentials, secret := newAuditTestStore(t)
	if _, err := database.ExecContext(t.Context(), `CREATE TRIGGER fail_mcp_audit BEFORE INSERT ON mcp_audit_entries BEGIN SELECT RAISE(FAIL, 'sensitive trigger detail'); END`); err != nil {
		t.Fatal(err)
	}
	var logs bytes.Buffer
	handler := newTransport(t, mcp.TransportConfig{
		Enabled: true, Credentials: credentials, Logger: log.New(&logs, "", 0),
		Tools: []mcp.Tool{{
			Name: "audit_failure_tool", Permission: mcp.PermissionMediaRead,
			InputSchema: map[string]any{"type": "object"},
			Resource: func(mcp.Context, json.RawMessage) (mcp.Resource, error) {
				return mcp.Resource{MediaID: "media_safe", RootID: "/private/source/path"}, nil
			},
			Call: func(mcp.Context, json.RawMessage) (mcp.ToolResult, error) {
				return mcp.ToolResult{Content: []mcp.ToolContent{{Type: "text", Text: "private payload"}}}, nil
			},
		}},
	})
	session := initialize(t, handler, secret)
	response := serve(handler, sessionRequest(`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"audit_failure_tool","arguments":{}}}`, secret, session))
	if response.Code != http.StatusOK {
		t.Fatalf("tool call status=%d body=%s", response.Code, response.Body.String())
	}
	if got, want := logs.String(), "{\"error_category\":\"mcp_audit_write\"}\n"; got != want {
		t.Fatalf("audit failure log = %q, want %q", got, want)
	}
	for _, forbidden := range []string{secret, "sensitive trigger detail", "/private/source/path", "private payload"} {
		if strings.Contains(logs.String(), forbidden) {
			t.Fatalf("audit failure log leaked %q: %q", forbidden, logs.String())
		}
	}
	credential, err := credentials.Authenticate(t.Context(), secret)
	if err != nil {
		t.Fatal(err)
	}
	entries, err := credentials.ListAudit(t.Context(), credential.ID, 1)
	if err != nil || len(entries) != 0 {
		t.Fatalf("audit entries after forced write failure = %#v, err=%v", entries, err)
	}
}

func TestTransportAuditsCommittedMutationWhenResultCannotBeReturned(t *testing.T) {
	cases := []struct {
		name   string
		result func() mcp.ToolResult
	}{
		{
			name: "oversized",
			result: func() mcp.ToolResult {
				return mcp.ToolResult{
					Content:           []mcp.ToolContent{{Type: "text", Text: strings.Repeat("x", (1<<20)+1)}},
					StructuredContent: map[string]any{"jobId": "j_committed"},
				}
			},
		},
		{
			name: "serialization_failure",
			result: func() mcp.ToolResult {
				return mcp.ToolResult{StructuredContent: map[string]any{"jobId": "j_committed", "unsupported": func() {}}}
			},
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			database, credentials, secret := newAuditTestStoreWithPermissions(t, []mcp.Permission{mcp.PermissionProjectsRead, mcp.PermissionProjectsWrite})
			if _, err := database.ExecContext(t.Context(), `CREATE TABLE cutlists (id TEXT PRIMARY KEY, value TEXT NOT NULL)`); err != nil {
				t.Fatal(err)
			}
			if _, err := database.ExecContext(t.Context(), `INSERT INTO cutlists (id, value) VALUES ('cutlist', 'before')`); err != nil {
				t.Fatal(err)
			}
			resource := mcp.Resource{ProjectID: "p_project", MediaID: "m_primary", ProjectMedia: make([]mcp.MediaResource, 40)}
			for i := range resource.ProjectMedia {
				resource.ProjectMedia[i] = mcp.MediaResource{ID: fmt.Sprintf("m_item_%02d", i), RootID: fmt.Sprintf("root_%02d", i)}
			}
			var mutationErr error
			handler := newTransport(t, mcp.TransportConfig{
				Enabled: true, Credentials: credentials,
				Tools: []mcp.Tool{{
					Name: "update_cutlist", Permission: mcp.PermissionProjectsWrite,
					InputSchema: map[string]any{"type": "object"},
					Resource:    func(mcp.Context, json.RawMessage) (mcp.Resource, error) { return resource, nil },
					Call: func(toolContext mcp.Context, _ json.RawMessage) (mcp.ToolResult, error) {
						_, mutationErr = database.ExecContext(toolContext.Request.Context(), `UPDATE cutlists SET value = 'committed' WHERE id = 'cutlist'`)
						return testCase.result(), mutationErr
					},
				}},
			})
			session := initialize(t, handler, secret)
			response := serve(handler, sessionRequest(`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"update_cutlist","arguments":{}}}`, secret, session))
			if mutationErr != nil {
				t.Fatalf("committed mutation error = %v", mutationErr)
			}
			if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), "Tool result exceeded the server limit") {
				t.Fatalf("safe result-limit response status=%d body=%q", response.Code, response.Body.String())
			}
			if strings.Contains(response.Body.String(), strings.Repeat("x", 128)) {
				t.Fatal("oversized tool response leaked into the RPC error")
			}
			var value string
			if err := database.QueryRowContext(t.Context(), `SELECT value FROM cutlists WHERE id = 'cutlist'`).Scan(&value); err != nil || value != "committed" {
				t.Fatalf("stored mutation value=%q err=%v", value, err)
			}
			credential, err := credentials.Authenticate(t.Context(), secret)
			if err != nil {
				t.Fatal(err)
			}
			entries, err := credentials.ListAudit(t.Context(), credential.ID, 1)
			if err != nil || len(entries) != 1 {
				t.Fatalf("audit entries=%#v err=%v", entries, err)
			}
			entry := entries[0]
			if entry.Operation != "update_cutlist" || entry.Outcome != "success" || entry.JobID != "j_committed" {
				t.Fatalf("completed mutation audit = %#v", entry)
			}
			if len(entry.ResourceIDs) != 32 || entry.ResourceIDs[0] != resource.ProjectID || entry.ResourceIDs[1] != resource.MediaID {
				t.Fatalf("bounded primary-first audit resources = %v", entry.ResourceIDs)
			}
		})
	}
}

func newAuditTestStore(t *testing.T) (*sql.DB, *mcp.CredentialStore, string) {
	return newAuditTestStoreWithPermissions(t, []mcp.Permission{mcp.PermissionMediaRead})
}

func newAuditTestStoreWithPermissions(t *testing.T, permissions []mcp.Permission) (*sql.DB, *mcp.CredentialStore, string) {
	t.Helper()
	database, err := store.OpenDatabase(t.Context(), t.TempDir()+"/audit.db")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	credentials, err := mcp.NewCredentialStore(newMCPRepository(t, database))
	if err != nil {
		t.Fatal(err)
	}
	expires := time.Now().Add(time.Hour)
	created, err := credentials.Create(t.Context(), mcp.CredentialInput{
		Name: "audit test", Permissions: permissions,
		MediaScope: mcp.MediaScope{Kind: mcp.MediaScopeAll}, ProjectScope: mcp.ProjectScope{Kind: mcp.ProjectScopeAll}, ExpiresAt: &expires,
	})
	if err != nil {
		t.Fatal(err)
	}
	return database, credentials, created.Secret
}
