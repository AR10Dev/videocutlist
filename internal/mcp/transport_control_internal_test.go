package mcp

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"runtime"
	"testing"
	"time"

	store "videocutlist/internal/db"
)

func TestTransportDeleteUsesReservedControlAdmissionAtWorkCapacity(t *testing.T) {
	clock := time.Date(2026, time.January, 2, 3, 4, 5, 0, time.UTC)
	database, err := store.OpenDatabase(t.Context(), t.TempDir()+"/mcp.db")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	mcpStorage, err := store.NewMCPStorage(database)
	if err != nil {
		t.Fatal(err)
	}
	credentials, err := NewCredentialStoreWithClock(mcpStorage, func() time.Time { return clock })
	if err != nil {
		t.Fatal(err)
	}
	expires := clock.Add(time.Hour)
	created, err := credentials.Create(t.Context(), CredentialInput{
		Name: "control admission", Permissions: []Permission{PermissionMediaRead},
		MediaScope: MediaScope{Kind: MediaScopeAll}, ProjectScope: ProjectScope{Kind: ProjectScopeAll}, ExpiresAt: &expires,
	})
	if err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{}, 1)
	release := make(chan struct{})
	handler, err := NewTransport(TransportConfig{
		Enabled: true, Credentials: credentials, MaxConcurrentRequests: 1,
		Tools: []Tool{{
			Name: "hold", Permission: PermissionMediaRead, InputSchema: map[string]any{"type": "object"},
			Resource: func(Context, json.RawMessage) (Resource, error) { return Resource{}, nil },
			Call: func(Context, json.RawMessage) (ToolResult, error) {
				started <- struct{}{}
				<-release
				return ToolResult{}, nil
			},
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	transport := handler
	sessionID := initializeBudgetSession(t, handler, created.Secret)
	credential, err := credentials.Authenticate(t.Context(), created.Secret)
	if err != nil {
		t.Fatal(err)
	}

	workResponse := make(chan int, 1)
	go func() {
		request := budgetRequest(http.MethodPost, created.Secret, sessionID, `{"jsonrpc":"2.0","id":"hold","method":"tools/call","params":{"name":"hold","arguments":{}}}`)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		workResponse <- response.Code
	}()
	<-started

	deleteResponse := make(chan int, 1)
	go func() {
		request := budgetRequest(http.MethodDelete, created.Secret, sessionID, "")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		deleteResponse <- response.Code
	}()

	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()
	for {
		transport.mu.Lock()
		admitted := transport.controlRequests[credential.ID] == 1 && transport.workRequests[credential.ID] == 1
		transport.mu.Unlock()
		if admitted {
			break
		}
		select {
		case <-timer.C:
			t.Fatal("DELETE did not acquire reserved control capacity while work was saturated")
		default:
			runtime.Gosched()
		}
	}
	close(release)

	select {
	case status := <-workResponse:
		if status != http.StatusOK {
			t.Errorf("work request status=%d, want 200", status)
		}
	case <-timer.C:
		t.Fatal("work request did not finish after release")
	}
	select {
	case status := <-deleteResponse:
		if status != http.StatusNoContent {
			t.Fatalf("DELETE status=%d, want 204", status)
		}
	case <-timer.C:
		t.Fatal("DELETE did not finish after the active work request drained")
	}
}
