package mcp_test

import (
	"bytes"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	store "videocutlist/internal/db"
	"videocutlist/internal/mcp"
)

const rpcHeaders = "application/json, text/event-stream"

func TestTransportEnablementCanChangeWithoutRestart(t *testing.T) {
	credentials, secret, _ := transportCredentials(t, time.Hour)
	enabled := false
	handler := newTransport(t, mcp.TransportConfig{EnabledFunc: func() bool { return enabled }, Credentials: credentials})
	response := serve(handler, request(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`, secret))
	if response.Code != http.StatusNotFound {
		t.Fatalf("disabled status = %d", response.Code)
	}
	enabled = true
	response = serve(handler, request(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}`, secret))
	if response.Code != http.StatusOK || response.Header().Get("Mcp-Session-Id") == "" {
		t.Fatalf("enabled status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestTransportDisabledAndAuthenticationAreIsolated(t *testing.T) {
	credentials, secret, _ := transportCredentials(t, time.Hour)
	disabled := newTransport(t, mcp.TransportConfig{Credentials: credentials})
	response := serve(disabled, request(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`, secret))
	if response.Code != http.StatusNotFound {
		t.Fatalf("disabled status = %d", response.Code)
	}

	enabled := newTransport(t, mcp.TransportConfig{Enabled: true, Credentials: credentials})
	unauthenticated := request(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`, "")
	unauthenticated.Header.Set("Authorization", "Bearer deployment-token")
	response = serve(enabled, unauthenticated)
	if response.Code != http.StatusUnauthorized || !strings.Contains(response.Header().Get("WWW-Authenticate"), "Bearer") {
		t.Fatalf("isolated auth response = %#v body=%s", response.Result(), response.Body.String())
	}
}

func TestTransportInitializationNegotiationDiscoveryAndCall(t *testing.T) {
	credentials, secret, _ := transportCredentials(t, time.Hour)
	called := false
	deniedResolved := false
	handler := newTransport(t, mcp.TransportConfig{
		Enabled: true, Credentials: credentials,
		Tools: []mcp.Tool{
			{Name: "list_media", Description: "List permitted media", Permission: mcp.PermissionMediaRead, InputSchema: map[string]any{"type": "object"}, Resource: func(mcp.Context, json.RawMessage) (mcp.Resource, error) { return mcp.Resource{}, nil }, Call: func(ctx mcp.Context, arguments json.RawMessage) (mcp.ToolResult, error) {
				called = ctx.Credential.ID != "" && string(arguments) == `{"query":"clip"}`
				return mcp.ToolResult{Content: []mcp.ToolContent{{Type: "text", Text: "one item"}}, StructuredContent: map[string]any{"count": 1}}, nil
			}},
			{Name: "start_export", Permission: mcp.PermissionExportsRun, InputSchema: map[string]any{"type": "object"}, Resource: func(mcp.Context, json.RawMessage) (mcp.Resource, error) {
				deniedResolved = true
				return mcp.Resource{}, nil
			}},
			{Name: "huge_result", Permission: mcp.PermissionMediaRead, InputSchema: map[string]any{"type": "object"}, Resource: func(mcp.Context, json.RawMessage) (mcp.Resource, error) { return mcp.Resource{}, nil }, Call: func(mcp.Context, json.RawMessage) (mcp.ToolResult, error) {
				return mcp.ToolResult{StructuredContent: map[string]any{"value": strings.Repeat("x", 2<<20)}}, nil
			}},
		},
	})

	initialize := request(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}`, secret)
	response := serve(handler, initialize)
	if response.Code != http.StatusOK || response.Header().Get("Mcp-Session-Id") == "" {
		t.Fatalf("initialize response = %#v body=%s", response.Result(), response.Body.String())
	}
	var initialized map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &initialized); err != nil || initialized["result"].(map[string]any)["protocolVersion"] != mcp.ProtocolVersion {
		t.Fatalf("negotiation response = %#v err=%v", initialized, err)
	}
	session := response.Header().Get("Mcp-Session-Id")

	list := sessionRequest(`{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}`, secret, session)
	response = serve(handler, list)
	if response.Code != http.StatusOK || strings.Contains(response.Body.String(), "start_export") || !strings.Contains(response.Body.String(), "list_media") {
		t.Fatalf("tool list status=%d body=%s", response.Code, response.Body.String())
	}

	call := sessionRequest(`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_media","arguments":{"query":"clip"}}}`, secret, session)
	response = serve(handler, call)
	if response.Code != http.StatusOK || !called || !strings.Contains(response.Body.String(), `"structuredContent":{"count":1}`) {
		t.Fatalf("tool call status=%d called=%v body=%s", response.Code, called, response.Body.String())
	}

	denied := sessionRequest(`{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"start_export","arguments":{}}}`, secret, session)
	response = serve(handler, denied)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), "Unknown or unauthorized tool") || deniedResolved {
		t.Fatalf("denied call status=%d resolved=%v body=%s", response.Code, deniedResolved, response.Body.String())
	}

	huge := sessionRequest(`{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"huge_result","arguments":{}}}`, secret, session)
	response = serve(handler, huge)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), "result exceeded") || response.Body.Len() > 1024 {
		t.Fatalf("huge result status=%d body bytes=%d body=%s", response.Code, response.Body.Len(), response.Body.String())
	}

	unsupported := sessionRequest(`{"jsonrpc":"2.0","id":6,"method":"ping"}`, secret, session)
	unsupported.Header.Set("MCP-Protocol-Version", "2099-01-01")
	response = serve(handler, unsupported)
	if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), "Unsupported MCP protocol version") {
		t.Fatalf("unsupported version status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestTransportRechecksRevocationAndExpiryForSessions(t *testing.T) {
	t.Run("revoked", func(t *testing.T) {
		credentials, secret, _ := transportCredentials(t, time.Hour)
		handler := newTransport(t, mcp.TransportConfig{Enabled: true, Credentials: credentials})
		session := initialize(t, handler, secret)
		credential, err := credentials.Authenticate(t.Context(), secret)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := credentials.Revoke(t.Context(), credential.ID); err != nil {
			t.Fatal(err)
		}
		response := serve(handler, sessionRequest(`{"jsonrpc":"2.0","id":2,"method":"ping"}`, secret, session))
		if response.Code != http.StatusUnauthorized {
			t.Fatalf("revoked status=%d body=%s", response.Code, response.Body.String())
		}
	})

	t.Run("expired", func(t *testing.T) {
		credentials, secret, clock := transportCredentials(t, time.Minute)
		handler := newTransport(t, mcp.TransportConfig{Enabled: true, Credentials: credentials, Now: func() time.Time { return *clock }})
		session := initialize(t, handler, secret)
		*clock = clock.Add(2 * time.Minute)
		response := serve(handler, sessionRequest(`{"jsonrpc":"2.0","id":2,"method":"ping"}`, secret, session))
		if response.Code != http.StatusUnauthorized {
			t.Fatalf("expired status=%d body=%s", response.Code, response.Body.String())
		}
	})
}

func TestTransportRecordsAuditAndStableToolErrorCodes(t *testing.T) {
	credentials, secret, _ := transportCredentials(t, time.Hour)
	handler := newTransport(t, mcp.TransportConfig{Enabled: true, Credentials: credentials, Tools: []mcp.Tool{{Name: "list_media", Permission: mcp.PermissionMediaRead, InputSchema: map[string]any{"type": "object"}, Resource: func(mcp.Context, json.RawMessage) (mcp.Resource, error) {
		return mcp.Resource{MediaID: "m_media", RootID: "root_a"}, nil
	}, Call: func(mcp.Context, json.RawMessage) (mcp.ToolResult, error) {
		return mcp.ToolResult{}, mcp.ErrProposalApprovalNeeded
	}}}})
	session := initialize(t, handler, secret)
	response := serve(handler, sessionRequest(`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_media","arguments":{}}}`, secret, session))
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"code":"missing_approval"`) {
		t.Fatalf("tool error status=%d body=%s", response.Code, response.Body.String())
	}
	credential, err := credentials.Authenticate(t.Context(), secret)
	if err != nil {
		t.Fatal(err)
	}
	entries, err := credentials.ListAudit(t.Context(), credential.ID, 1)
	if err != nil || len(entries) != 1 || entries[0].Operation != "list_media" || entries[0].Outcome != "missing_approval" {
		t.Fatalf("audit entries=%#v err=%v", entries, err)
	}
}

func TestTransportBoundsAndSafeErrors(t *testing.T) {
	credentials, secret, _ := transportCredentials(t, time.Hour)
	handler := newTransport(t, mcp.TransportConfig{Enabled: true, Credentials: credentials})

	malformed := request(`{"jsonrpc":`, secret)
	response := serve(handler, malformed)
	if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), "Parse error") {
		t.Fatalf("malformed status=%d body=%s", response.Code, response.Body.String())
	}

	oversized := request(`"`+strings.Repeat("x", 2<<20)+`"`, secret)
	response = serve(handler, oversized)
	if response.Code != http.StatusRequestEntityTooLarge || response.Body.Len() > 1024 {
		t.Fatalf("oversized status=%d body bytes=%d", response.Code, response.Body.Len())
	}

	limited := newTransport(t, mcp.TransportConfig{Enabled: true, Credentials: credentials, RequestsPerMinute: 1})
	_ = serve(limited, request(`{"jsonrpc":`, secret))
	response = serve(limited, request(`{"jsonrpc":`, secret))
	if response.Code != http.StatusTooManyRequests {
		t.Fatalf("rate status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestTransportRejectsUntrustedOriginAndInsecureRemoteAccess(t *testing.T) {
	credentials, secret, _ := transportCredentials(t, time.Hour)
	info := mcp.RequestInfo{ClientIP: net.ParseIP("203.0.113.7"), Host: "video.test", Proto: "http"}
	requestInfo := func(_ *http.Request) mcp.RequestInfo { return info }
	handler := newTransport(t, mcp.TransportConfig{
		Enabled: true, Credentials: credentials,
		AllowedOrigins: []string{"https://video.test"}, RequestInfo: requestInfo,
	})
	response := serve(handler, request(`{}`, secret))
	if response.Code != http.StatusForbidden {
		t.Fatalf("insecure remote status = %d", response.Code)
	}

	info.Proto = "https"
	origin := request(`{}`, secret)
	origin.Header.Set("Origin", "https://attacker.test")
	response = serve(handler, origin)
	if response.Code != http.StatusForbidden {
		t.Fatalf("foreign origin status = %d", response.Code)
	}

	sameOrigin := newTransport(t, mcp.TransportConfig{
		Enabled: true, Credentials: credentials, RequestInfo: requestInfo,
	})
	sameOriginRequest := request(`{"jsonrpc":`, secret)
	sameOriginRequest.Header.Set("Origin", "https://video.test")
	response = serve(sameOrigin, sameOriginRequest)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("same-origin secure status = %d body=%s", response.Code, response.Body.String())
	}
}

func transportCredentials(t *testing.T, lifetime time.Duration) (*mcp.CredentialStore, string, *time.Time) {
	t.Helper()
	clock := time.Date(2026, time.January, 2, 3, 4, 5, 0, time.UTC)
	database, err := store.OpenDatabase(t.Context(), t.TempDir()+"/mcp.db")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	credentials, err := mcp.NewCredentialStoreWithClock(database, func() time.Time { return clock })
	if err != nil {
		t.Fatal(err)
	}
	expires := clock.Add(lifetime)
	created, err := credentials.Create(t.Context(), mcp.CredentialInput{
		Name: "test", Permissions: []mcp.Permission{mcp.PermissionMediaRead},
		MediaScope: mcp.MediaScope{Kind: mcp.MediaScopeAll}, ProjectScope: mcp.ProjectScope{Kind: mcp.ProjectScopeAll}, ExpiresAt: &expires,
	})
	if err != nil {
		t.Fatal(err)
	}
	return credentials, created.Secret, &clock
}

func newTransport(t *testing.T, config mcp.TransportConfig) http.Handler {
	t.Helper()
	handler, err := mcp.NewTransport(config)
	if err != nil {
		t.Fatal(err)
	}
	return handler
}

func request(body, secret string) *http.Request {
	r := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:8787/mcp", bytes.NewBufferString(body))
	r.RemoteAddr = "127.0.0.1:1234"
	r.Header.Set("Accept", rpcHeaders)
	r.Header.Set("Content-Type", "application/json")
	if secret != "" {
		r.Header.Set("Authorization", "Bearer "+secret)
	}
	return r
}

func sessionRequest(body, secret, session string) *http.Request {
	r := request(body, secret)
	r.Header.Set("Mcp-Session-Id", session)
	r.Header.Set("MCP-Protocol-Version", mcp.ProtocolVersion)
	return r
}

func initialize(t *testing.T, handler http.Handler, secret string) string {
	t.Helper()
	response := serve(handler, request(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}`, secret))
	if response.Code != http.StatusOK || response.Header().Get("Mcp-Session-Id") == "" {
		t.Fatalf("initialize status=%d body=%s", response.Code, response.Body.String())
	}
	return response.Header().Get("Mcp-Session-Id")
}

func serve(handler http.Handler, request *http.Request) *httptest.ResponseRecorder {
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}
