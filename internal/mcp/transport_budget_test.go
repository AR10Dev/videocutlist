package mcp_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"videocutlist/internal/mcp"
)

func TestTransportSessionCapacityAndReleaseBudgets(t *testing.T) {
	credentials, secret, clock := transportCredentials(t, 10*time.Hour)
	other, err := createBudgetCredential(t, credentials, *clock)
	if err != nil {
		t.Fatal(err)
	}
	handler := newTransport(t, mcp.TransportConfig{
		Enabled: true, Credentials: credentials, MaxSessions: 1, SessionTTL: time.Minute,
		Now: func() time.Time { return *clock },
	})

	first := initialize(t, handler, secret)
	for range 3 {
		response := serve(handler, sessionRequest(`{"jsonrpc":"2.0","id":2,"method":"ping"}`, secret, first))
		if response.Code != http.StatusOK {
			t.Fatalf("existing-session ping consumed capacity: status=%d body=%s", response.Code, response.Body.String())
		}
	}
	secondForSameCredential := serve(handler, request(initializeRequestBody(), secret))
	if secondForSameCredential.Code != http.StatusServiceUnavailable {
		t.Fatalf("second same-credential initialization status=%d body=%s", secondForSameCredential.Code, secondForSameCredential.Body.String())
	}

	otherSession := initialize(t, handler, other.Secret)
	otherPing := serve(handler, sessionRequest(`{"jsonrpc":"2.0","id":3,"method":"ping"}`, other.Secret, otherSession))
	if otherPing.Code != http.StatusOK {
		t.Fatalf("credential B did not receive its own session capacity: status=%d body=%s", otherPing.Code, otherPing.Body.String())
	}
	crossCredential := serve(handler, sessionRequest(`{"jsonrpc":"2.0","id":4,"method":"ping"}`, other.Secret, first))
	if crossCredential.Code != http.StatusNotFound {
		t.Fatalf("credential B reused credential A's session: status=%d body=%s", crossCredential.Code, crossCredential.Body.String())
	}
	for _, tc := range []struct{ token, session string }{{secret, first}, {other.Secret, otherSession}} {
		response := serve(handler, sessionRequest(`{"jsonrpc":"2.0","id":5,"method":"ping"}`, tc.token, tc.session))
		if response.Code != http.StatusOK {
			t.Fatalf("cross-credential rejection affected session %q: status=%d body=%s", tc.session, response.Code, response.Body.String())
		}
	}
	otherAtCapacity := serve(handler, request(initializeRequestBody(), other.Secret))
	if otherAtCapacity.Code != http.StatusServiceUnavailable {
		t.Fatalf("second credential B initialization status=%d body=%s", otherAtCapacity.Code, otherAtCapacity.Body.String())
	}

	deleteBudgetSession(t, handler, secret, first)
	deleteBudgetSession(t, handler, other.Secret, otherSession)
	replacement := serve(handler, request(initializeRequestBody(), secret))
	if replacement.Code != http.StatusOK || replacement.Header().Get("Mcp-Session-Id") == "" {
		t.Fatalf("deletion did not release session capacity: status=%d body=%s", replacement.Code, replacement.Body.String())
	}
	deleteBudgetSession(t, handler, secret, replacement.Header().Get("Mcp-Session-Id"))

	// An invalid SDK initialization may carry an HTTP session header even though
	// no initialized SDK session exists. It must not retain the application slot.
	invalid := serve(handler, request(`{"jsonrpc":"2.0","id":"bad-init","method":"initialize","params":{"protocolVersion":5}}`, secret))
	if invalid.Code == http.StatusServiceUnavailable || (invalid.Code == http.StatusOK && !strings.Contains(invalid.Body.String(), `"error"`)) {
		t.Fatalf("initialization was not rejected as invalid: status=%d body=%s", invalid.Code, invalid.Body.String())
	}
	validAfterInvalid := serve(handler, request(initializeRequestBody(), secret))
	if validAfterInvalid.Code != http.StatusOK || validAfterInvalid.Header().Get("Mcp-Session-Id") == "" {
		t.Fatalf("failed initialization leaked capacity: status=%d body=%s", validAfterInvalid.Code, validAfterInvalid.Body.String())
	}

	*clock = clock.Add(time.Minute)
	afterTTL := serve(handler, request(initializeRequestBody(), secret))
	if afterTTL.Code != http.StatusOK || afterTTL.Header().Get("Mcp-Session-Id") == "" {
		t.Fatalf("TTL expiry did not release session capacity: status=%d body=%s", afterTTL.Code, afterTTL.Body.String())
	}
}

func TestTransportRateLimitIsPerCredential(t *testing.T) {
	credentials, secret, clock := transportCredentials(t, 10*time.Hour)
	other, err := createBudgetCredential(t, credentials, *clock)
	if err != nil {
		t.Fatal(err)
	}
	handler := newTransport(t, mcp.TransportConfig{
		Enabled: true, Credentials: credentials, RequestsPerMinute: 1,
		Now: func() time.Time { return *clock },
	})

	first := serve(handler, request(initializeRequestBody(), secret))
	if first.Code != http.StatusOK {
		t.Fatalf("credential A initialization status=%d body=%s", first.Code, first.Body.String())
	}
	limited := serve(handler, request(initializeRequestBody(), secret))
	if limited.Code != http.StatusTooManyRequests {
		t.Fatalf("credential A rate limit status=%d body=%s", limited.Code, limited.Body.String())
	}
	independent := serve(handler, request(initializeRequestBody(), other.Secret))
	if independent.Code != http.StatusOK {
		t.Fatalf("credential B did not receive independent rate budget: status=%d body=%s", independent.Code, independent.Body.String())
	}

	*clock = clock.Add(time.Minute)
	afterWindow := serve(handler, sessionRequest(`{"jsonrpc":"2.0","id":2,"method":"ping"}`, secret, first.Header().Get("Mcp-Session-Id")))
	if afterWindow.Code != http.StatusOK {
		t.Fatalf("expired rate window did not release budget: status=%d body=%s", afterWindow.Code, afterWindow.Body.String())
	}
}

func TestTransportConcurrentWorkIsPerCredentialAndControlsRemainAdmitted(t *testing.T) {
	credentials, secretA, clock := transportCredentials(t, 10*time.Hour)
	credentialB, err := createBudgetCredential(t, credentials, *clock)
	if err != nil {
		t.Fatal(err)
	}
	started := make(chan string, 2)
	tool := mcp.Tool{
		Name: "block", Permission: mcp.PermissionMediaRead, InputSchema: map[string]any{"type": "object"},
		Resource: func(mcp.Context, json.RawMessage) (mcp.Resource, error) { return mcp.Resource{}, nil },
		Call: func(ctx mcp.Context, _ json.RawMessage) (mcp.ToolResult, error) {
			started <- ctx.Credential.ID
			<-ctx.Request.Context().Done()
			return mcp.ToolResult{}, ctx.Request.Context().Err()
		},
	}
	handler := newTransport(t, mcp.TransportConfig{
		Enabled: true, Credentials: credentials, Tools: []mcp.Tool{tool}, MaxConcurrentRequests: 1,
	})
	sessionA := initialize(t, handler, secretA)
	sessionB := initialize(t, handler, credentialB.Secret)

	startCall := func(token, sessionID, requestID string) <-chan int {
		finished := make(chan int, 1)
		body := `{"jsonrpc":"2.0","id":"` + requestID + `","method":"tools/call","params":{"name":"block","arguments":{}}}`
		go func() {
			finished <- serve(handler, sessionRequest(body, token, sessionID)).Code
		}()
		return finished
	}
	credentialAAccount, err := credentials.Authenticate(t.Context(), secretA)
	if err != nil {
		t.Fatal(err)
	}
	credentialBAccount, err := credentials.Authenticate(t.Context(), credentialB.Secret)
	if err != nil {
		t.Fatal(err)
	}
	callA := startCall(secretA, sessionA, "blocked-a")
	if got := <-started; got != credentialAAccount.ID {
		t.Fatalf("started credential %q, want A=%q", got, credentialAAccount.ID)
	}
	limitedA := serve(handler, sessionRequest(`{"jsonrpc":"2.0","id":4,"method":"ping"}`, secretA, sessionA))
	if limitedA.Code != http.StatusTooManyRequests {
		t.Fatalf("saturated credential A status=%d body=%s", limitedA.Code, limitedA.Body.String())
	}

	callB := startCall(credentialB.Secret, sessionB, "blocked-b")
	if got := <-started; got != credentialBAccount.ID {
		t.Fatalf("started credential %q, want independent B=%q", got, credentialBAccount.ID)
	}
	limitedB := serve(handler, sessionRequest(`{"jsonrpc":"2.0","id":5,"method":"ping"}`, credentialB.Secret, sessionB))
	if limitedB.Code != http.StatusTooManyRequests {
		t.Fatalf("saturated credential B status=%d body=%s", limitedB.Code, limitedB.Body.String())
	}

	cancelA := serve(handler, sessionRequest(`{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":"blocked-a"}}`, secretA, sessionA))
	if cancelA.Code != http.StatusAccepted {
		t.Fatalf("reserved cancellation admission status=%d body=%s", cancelA.Code, cancelA.Body.String())
	}
	select {
	case <-callA:
	case <-time.After(5 * time.Second):
		t.Fatal("cancelled tool call did not release its work slot")
	}

	cancelB := serve(handler, sessionRequest(`{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":"blocked-b"}}`, credentialB.Secret, sessionB))
	if cancelB.Code != http.StatusAccepted {
		t.Fatalf("credential B cancellation admission status=%d body=%s", cancelB.Code, cancelB.Body.String())
	}
	select {
	case <-callB:
	case <-time.After(5 * time.Second):
		t.Fatal("credential B cancellation did not release its work slot")
	}

	pingA := serve(handler, sessionRequest(`{"jsonrpc":"2.0","id":6,"method":"ping"}`, secretA, sessionA))
	if pingA.Code != http.StatusOK {
		t.Fatalf("cancellation did not release credential A's slot: status=%d body=%s", pingA.Code, pingA.Body.String())
	}
}

func createBudgetCredential(t *testing.T, credentials *mcp.CredentialStore, now time.Time) (mcp.CreatedCredential, error) {
	t.Helper()
	expires := now.Add(10 * time.Hour)
	return credentials.Create(t.Context(), mcp.CredentialInput{
		Name: "budget peer", Permissions: []mcp.Permission{mcp.PermissionMediaRead},
		MediaScope: mcp.MediaScope{Kind: mcp.MediaScopeAll}, ProjectScope: mcp.ProjectScope{Kind: mcp.ProjectScopeAll}, ExpiresAt: &expires,
	})
}

func initializeRequestBody() string {
	return `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}`
}

func deleteBudgetSession(t *testing.T, handler http.Handler, secret, sessionID string) {
	t.Helper()
	response := serve(handler, newDeleteSessionRequest(secret, sessionID))
	if response.Code != http.StatusNoContent {
		t.Fatalf("delete status=%d body=%s", response.Code, response.Body.String())
	}
}

func newDeleteSessionRequest(secret, sessionID string) *http.Request {
	r := httptest.NewRequest(http.MethodDelete, "http://127.0.0.1:8787/mcp", nil)
	r.RemoteAddr = "127.0.0.1:1234"
	r.Header.Set("Authorization", "Bearer "+secret)
	r.Header.Set("MCP-Protocol-Version", mcp.ProtocolVersion)
	r.Header.Set("Mcp-Session-Id", sessionID)
	return r
}
