package mcp

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	store "videocutlist/internal/db"
)

func TestTransportApplicationAndSDKSessionLifecyclesStayInSync(t *testing.T) {
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
	expires := clock.Add(10 * time.Hour)
	created, err := credentials.Create(t.Context(), CredentialInput{
		Name: "session budget", Permissions: []Permission{PermissionMediaRead},
		MediaScope: MediaScope{Kind: MediaScopeAll}, ProjectScope: ProjectScope{Kind: ProjectScopeAll}, ExpiresAt: &expires,
	})
	if err != nil {
		t.Fatal(err)
	}
	handler, err := NewTransport(TransportConfig{
		Enabled: true, Credentials: credentials, MaxSessions: 1, SessionTTL: time.Minute,
		Now: func() time.Time { return clock },
	})
	if err != nil {
		t.Fatal(err)
	}
	transport := handler

	firstID := initializeBudgetSession(t, handler, created.Secret)
	first := transport.sessions[firstID]
	if first == nil || !first.initialized || !serverHasInitializedSession(first.server, firstID) {
		t.Fatalf("application session does not match initialized SDK session: %#v", first)
	}

	// The SDK can expire or close a session without updating application-owned
	// capacity bookkeeping. A later admission must reconcile both maps.
	closeServerSession(first.server, firstID)
	if serverHasInitializedSession(first.server, firstID) {
		t.Fatal("SDK session remained after close")
	}
	if _, ok := transport.sessions[firstID]; !ok {
		t.Fatal("test setup expected stale application bookkeeping before reconciliation")
	}
	replacementID := initializeBudgetSession(t, handler, created.Secret)
	if replacementID == firstID || transport.sessions[firstID] != nil || serverHasInitializedSession(first.server, firstID) {
		t.Fatalf("SDK-missing session was not reconciled: old=%q new=%q", firstID, replacementID)
	}

	// SDK DELETE owns its transport state; the application must release its
	// credential capacity after that lifecycle transition as well.
	replacement := transport.sessions[replacementID]
	deleteBudgetSessionInternal(t, handler, created.Secret, replacementID)
	if transport.sessions[replacementID] != nil || serverHasInitializedSession(replacement.server, replacementID) {
		t.Fatal("DELETE left application or SDK session state behind")
	}

	ttlID := initializeBudgetSession(t, handler, created.Secret)
	ttlEntry := transport.sessions[ttlID]
	clock = clock.Add(time.Minute)
	afterTTL := initializeBudgetSession(t, handler, created.Secret)
	if afterTTL == ttlID || transport.sessions[ttlID] != nil || serverHasInitializedSession(ttlEntry.server, ttlID) {
		t.Fatalf("TTL did not release actual and application session state: old=%q new=%q", ttlID, afterTTL)
	}
}

func initializeBudgetSession(t *testing.T, handler http.Handler, secret string) string {
	t.Helper()
	request := budgetRequest(http.MethodPost, secret, "", `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"budget-test","version":"1"}}}`)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("initialize status=%d body=%s", response.Code, response.Body.String())
	}
	id := response.Header().Get("Mcp-Session-Id")
	if id == "" {
		t.Fatalf("initialize did not return session ID: %s", response.Body.String())
	}
	return id
}

func deleteBudgetSessionInternal(t *testing.T, handler http.Handler, secret, sessionID string) {
	t.Helper()
	request := budgetRequest(http.MethodDelete, secret, sessionID, "")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusNoContent {
		t.Fatalf("delete status=%d body=%s", response.Code, response.Body.String())
	}
}

func budgetRequest(method, secret, sessionID, body string) *http.Request {
	request := httptest.NewRequest(method, "http://127.0.0.1:8787/mcp", bytes.NewBufferString(body))
	request.RemoteAddr = "127.0.0.1:1234"
	request.Header.Set("Authorization", "Bearer "+secret)
	if method == http.MethodPost {
		request.Header.Set("Accept", "application/json, text/event-stream")
		request.Header.Set("Content-Type", "application/json")
	}
	if sessionID != "" {
		request.Header.Set("MCP-Protocol-Version", ProtocolVersion)
		request.Header.Set("Mcp-Session-Id", sessionID)
	}
	return request
}
