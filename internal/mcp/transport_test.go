package mcp_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	store "videocutlist/internal/db"
	"videocutlist/internal/httpapi"
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
				return mcp.ToolResult{StructuredContent: map[string]any{"value": "sensitive-result-canary-" + strings.Repeat("x", 2<<20)}}, nil
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
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), "result exceeded") || response.Body.Len() > 1024 || strings.Contains(response.Body.String(), "sensitive-result-canary") {
		t.Fatalf("huge result status=%d body bytes=%d body=%s", response.Code, response.Body.Len(), response.Body.String())
	}

	unsupported := sessionRequest(`{"jsonrpc":"2.0","id":6,"method":"ping"}`, secret, session)
	unsupported.Header.Set("MCP-Protocol-Version", "2099-01-01")
	response = serve(handler, unsupported)
	if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), "Unsupported MCP protocol version") {
		t.Fatalf("unsupported version status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestTransportPreservesLargeNumericRequestIDs(t *testing.T) {
	credentials, secret, _ := transportCredentials(t, time.Hour)
	handler := newTransport(t, mcp.TransportConfig{Enabled: true, Credentials: credentials})
	const id = `9007199254740993`
	response := serve(handler, request(`{"jsonrpc":"2.0","id":`+id+`,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}`, secret))
	if response.Code != http.StatusOK {
		t.Fatalf("initialize status=%d body=%s", response.Code, response.Body.String())
	}
	var envelope struct {
		ID json.RawMessage `json:"id"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil || string(envelope.ID) != id {
		t.Fatalf("initialize ID=%s err=%v", envelope.ID, err)
	}
	session := response.Header().Get("Mcp-Session-Id")
	response = serve(handler, sessionRequest(`{"jsonrpc":"2.0","id":`+id+`,"method":"ping"}`, secret, session))
	if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil || string(envelope.ID) != id {
		t.Fatalf("ping ID=%s err=%v", envelope.ID, err)
	}
}

func TestTransportNumericIDAndRequestFraming(t *testing.T) {
	credentials, secret, _ := transportCredentials(t, time.Hour)
	calls := 0
	handler := newTransport(t, mcp.TransportConfig{Enabled: true, Credentials: credentials, Tools: []mcp.Tool{{
		Name: "count", Permission: mcp.PermissionMediaRead, InputSchema: map[string]any{"type": "object"},
		Call: func(mcp.Context, json.RawMessage) (mcp.ToolResult, error) {
			calls++
			return mcp.ToolResult{}, nil
		},
	}}})

	initializeBody := `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}`
	response := serve(handler, request(initializeBody, secret))
	if response.Code != http.StatusOK {
		t.Fatalf("initialize status=%d body=%s", response.Code, response.Body.String())
	}
	session := response.Header().Get("Mcp-Session-Id")
	notification := serve(handler, sessionRequest(`{"jsonrpc":"2.0","method":"notifications/initialized"}`, secret, session))
	if notification.Code != http.StatusAccepted || notification.Body.Len() != 0 {
		t.Fatalf("lifecycle notification status=%d body=%s", notification.Code, notification.Body.String())
	}
	valid := []string{`1`, `-1`, `1.25`, `1e3`, `"id"`}
	for _, id := range valid {
		t.Run("id "+id, func(t *testing.T) {
			body := `{"jsonrpc":"2.0","id":` + id + `,"method":"ping"}`
			got := serve(handler, sessionRequest(body, secret, session))
			if got.Code != http.StatusOK {
				t.Fatalf("status=%d body=%s", got.Code, got.Body.String())
			}
			if !bytes.Contains(got.Body.Bytes(), []byte(`"id":`+id)) {
				t.Fatalf("response does not preserve ID %s: %s", id, got.Body.String())
			}
		})
	}
	for _, body := range []string{
		`{"jsonrpc":"2.0","id":true,"method":"tools/call","params":{"name":"count","arguments":{}}}`,
		`{"jsonrpc":"2.0","id":{},"method":"tools/call","params":{"name":"count","arguments":{}}}`,
		`{"jsonrpc":"2.0","id":[],"method":"tools/call","params":{"name":"count","arguments":{}}}`,
		`{"jsonrpc":"2.0","id":"` + strings.Repeat("x", 129) + `","method":"tools/call","params":{"name":"count","arguments":{}}}`,
		`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"count","arguments":{}}} {}`,
		`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"count","arguments":{}}`,
	} {
		got := serve(handler, sessionRequest(body, secret, session))
		if got.Code < 400 {
			t.Errorf("accepted invalid framing %q: status=%d body=%s", body, got.Code, got.Body.String())
		}
	}
	oversized := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"count","arguments":{}}}` + strings.Repeat(" ", 1<<20)
	got := serve(handler, sessionRequest(oversized, secret, session))
	if got.Code != http.StatusRequestEntityTooLarge || calls != 0 {
		t.Fatalf("oversized status=%d calls=%d body=%s", got.Code, calls, got.Body.String())
	}
	for _, body := range []string{
		`{"jsonrpc":"2.0","id":null,"method":"tools/call","params":{"name":"count","arguments":{}}}`,
		`{"jsonrpc":"2.0","method":"ping"}`,
	} {
		got := serve(handler, sessionRequest(body, secret, session))
		if got.Code < 400 || calls != 0 {
			t.Errorf("accepted unsupported ID/notification framing %q: status=%d calls=%d body=%s", body, got.Code, calls, got.Body.String())
		}
	}
}

func TestTransportHidesDeniedToolsAndBindsSessionsToCredentials(t *testing.T) {
	credentials, secret, clock := transportCredentials(t, time.Hour)
	otherExpiry := clock.Add(time.Hour)
	other, err := credentials.Create(t.Context(), mcp.CredentialInput{
		Name: "other", Permissions: []mcp.Permission{mcp.PermissionMediaRead},
		MediaScope: mcp.MediaScope{Kind: mcp.MediaScopeAll}, ProjectScope: mcp.ProjectScope{Kind: mcp.ProjectScopeAll}, ExpiresAt: &otherExpiry,
	})
	if err != nil {
		t.Fatal(err)
	}
	resolved := false
	handler := newTransport(t, mcp.TransportConfig{Enabled: true, Credentials: credentials, Tools: []mcp.Tool{{
		Name: "private_tool", Permission: mcp.PermissionExportsRun, InputSchema: map[string]any{"type": "object"},
		Resource: func(mcp.Context, json.RawMessage) (mcp.Resource, error) {
			resolved = true
			return mcp.Resource{MediaID: "secret_media", RootID: "secret_root"}, nil
		},
		Call: func(mcp.Context, json.RawMessage) (mcp.ToolResult, error) { return mcp.ToolResult{}, nil },
	}}})
	session := initialize(t, handler, secret)

	call := func(token, name string) *httptest.ResponseRecorder {
		body := `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"` + name + `","arguments":{}}}`
		return serve(handler, sessionRequest(body, token, session))
	}
	denied := call(secret, "private_tool")
	unknown := call(secret, "unknown_private_tool")
	if denied.Code != http.StatusOK || unknown.Code != http.StatusOK || denied.Body.String() != unknown.Body.String() {
		t.Fatalf("denied/unknown responses differ: denied=%d %s unknown=%d %s", denied.Code, denied.Body.String(), unknown.Code, unknown.Body.String())
	}
	if resolved || strings.Contains(denied.Body.String(), "private_tool") || strings.Contains(denied.Body.String(), "secret_") {
		t.Fatalf("denied response leaked tool/resource: resolved=%v body=%s", resolved, denied.Body.String())
	}

	crossCredential := call(other.Secret, "private_tool")
	if crossCredential.Code != http.StatusNotFound {
		t.Fatalf("cross-credential session status=%d body=%s", crossCredential.Code, crossCredential.Body.String())
	}
}

func TestTransportRechecksRevocationAndExpiryForSessions(t *testing.T) {
	t.Run("revoked", func(t *testing.T) {
		credentials, secret, _ := transportCredentials(t, time.Hour)
		toolCalled := false
		handler := newTransport(t, mcp.TransportConfig{Enabled: true, Credentials: credentials, Tools: []mcp.Tool{{
			Name: "read_media", Permission: mcp.PermissionMediaRead, InputSchema: map[string]any{"type": "object"},
			Resource: func(mcp.Context, json.RawMessage) (mcp.Resource, error) { return mcp.Resource{MediaID: "m_clip"}, nil },
			Call: func(mcp.Context, json.RawMessage) (mcp.ToolResult, error) {
				toolCalled = true
				return mcp.ToolResult{}, nil
			},
		}}})
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
		response = serve(handler, sessionRequest(`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"read_media","arguments":{}}}`, secret, session))
		if response.Code != http.StatusUnauthorized || toolCalled {
			t.Fatalf("revoked tool call status=%d called=%v body=%s", response.Code, toolCalled, response.Body.String())
		}
	})

	t.Run("expired", func(t *testing.T) {
		credentials, secret, clock := transportCredentials(t, time.Minute)
		toolCalled := false
		handler := newTransport(t, mcp.TransportConfig{Enabled: true, Credentials: credentials, Now: func() time.Time { return *clock }, Tools: []mcp.Tool{{
			Name: "read_media", Permission: mcp.PermissionMediaRead, InputSchema: map[string]any{"type": "object"},
			Resource: func(mcp.Context, json.RawMessage) (mcp.Resource, error) { return mcp.Resource{MediaID: "m_clip"}, nil },
			Call: func(mcp.Context, json.RawMessage) (mcp.ToolResult, error) {
				toolCalled = true
				return mcp.ToolResult{}, nil
			},
		}}})
		session := initialize(t, handler, secret)
		*clock = clock.Add(2 * time.Minute)
		response := serve(handler, sessionRequest(`{"jsonrpc":"2.0","id":2,"method":"ping"}`, secret, session))
		if response.Code != http.StatusUnauthorized {
			t.Fatalf("expired status=%d body=%s", response.Code, response.Body.String())
		}
		response = serve(handler, sessionRequest(`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"read_media","arguments":{}}}`, secret, session))
		if response.Code != http.StatusUnauthorized || toolCalled {
			t.Fatalf("expired tool call status=%d called=%v body=%s", response.Code, toolCalled, response.Body.String())
		}
	})
}

func TestTransportToolAuthorizationDoesNotPassConcurrentRevocation(t *testing.T) {
	database, err := store.OpenDatabase(t.Context(), t.TempDir()+"/mcp-tool-revocation-race.db")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	now := time.Now().UTC()
	expires := now.Add(time.Hour)
	repository := &blockingCredentialRepository{CredentialRepository: newMCPRepository(t, database)}
	credentials, err := mcp.NewCredentialStoreWithClock(repository, func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	created, err := credentials.Create(t.Context(), mcp.CredentialInput{
		Name: "tool revocation race", Permissions: []mcp.Permission{mcp.PermissionMediaRead},
		MediaScope: mcp.MediaScope{Kind: mcp.MediaScopeAll}, ProjectScope: mcp.ProjectScope{Kind: mcp.ProjectScopeAll}, ExpiresAt: &expires,
	})
	if err != nil {
		t.Fatal(err)
	}
	toolCalled := false
	handler := newTransport(t, mcp.TransportConfig{Enabled: true, Credentials: credentials, Tools: []mcp.Tool{{
		Name: "read_media", Permission: mcp.PermissionMediaRead, InputSchema: map[string]any{"type": "object"},
		Resource: func(mcp.Context, json.RawMessage) (mcp.Resource, error) { return mcp.Resource{MediaID: "m_clip"}, nil },
		Call: func(mcp.Context, json.RawMessage) (mcp.ToolResult, error) {
			toolCalled = true
			return mcp.ToolResult{}, nil
		},
	}}})
	sessionID := initialize(t, handler, created.Secret)
	repository.pauseTouchAfter(3)
	responseDone := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		responseDone <- serve(handler, sessionRequest(`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"read_media","arguments":{}}}`, created.Secret, sessionID))
	}()
	defer repository.resumeTouch()
	select {
	case <-repository.touchStarted:
	case <-time.After(5 * time.Second):
		t.Fatal("tool authorization did not reach its conditional last-used update")
	}
	if _, err := credentials.Revoke(t.Context(), created.ID); err != nil {
		t.Fatal(err)
	}
	repository.resumeTouch()
	response := <-responseDone
	if response.Code != http.StatusOK || toolCalled {
		t.Fatalf("tool passed concurrent revocation: status=%d called=%v body=%s", response.Code, toolCalled, response.Body.String())
	}
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

func TestTransportRejectsOversizedTrailingJSON(t *testing.T) {
	credentials, secret, _ := transportCredentials(t, time.Hour)
	handler := newTransport(t, mcp.TransportConfig{Enabled: true, Credentials: credentials})
	response := serve(handler, request(`{"jsonrpc":"2.0","id":1,"method":"initialize"}`+strings.Repeat(" ", 2<<20), secret))
	if response.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized trailing JSON status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestTransportConfiguredPublicAuthorityThroughTrustedProxy(t *testing.T) {
	credentials, secret, _ := transportCredentials(t, time.Hour)
	makeHandler := func(publicURL string) http.Handler {
		transport := newTransport(t, mcp.TransportConfig{
			Enabled: true, Credentials: credentials, PublicBaseURL: publicURL,
			RequestInfo: func(r *http.Request) mcp.RequestInfo {
				info := httpapi.GetForwardedInfo(r.Context())
				return mcp.RequestInfo{ClientIP: info.ClientIP, Host: info.Host, Proto: info.Proto}
			},
		})
		hostGuard := httpapi.HostGuard(8080, publicURL, transport)
		proxy, err := httpapi.TrustedProxy([]string{"127.0.0.0/8"}, hostGuard)
		if err != nil {
			t.Fatal(err)
		}
		return proxy
	}

	requestFor := func(host, forwardedHost, proto, origin string) *http.Request {
		r := request(`{}`, secret)
		r.Host = host
		r.RemoteAddr = "127.0.0.1:43210"
		r = r.WithContext(context.WithValue(r.Context(), http.LocalAddrContextKey, &net.TCPAddr{IP: net.ParseIP("127.0.0.1"), Port: 8080}))
		r.Header.Set("X-Forwarded-For", "203.0.113.7")
		r.Header.Set("X-Forwarded-Host", forwardedHost)
		r.Header.Set("X-Forwarded-Proto", proto)
		if origin != "" {
			r.Header.Set("Origin", origin)
		}
		return r
	}

	handler := makeHandler("https://mcp.example.test:8443")
	response := serve(handler, requestFor("localhost:8080", "mcp.example.test:8443", "https", "https://mcp.example.test:8443"))
	if response.Code == http.StatusForbidden {
		t.Fatalf("configured public authority rejected: %d %s", response.Code, response.Body.String())
	}
	for _, tc := range []struct {
		name, host, forwardedHost, proto, origin string
	}{
		{name: "wrong forwarded host", host: "localhost:8080", forwardedHost: "attacker.test:8443", proto: "https"},
		{name: "wrong public port", host: "localhost:8080", forwardedHost: "mcp.example.test:9443", proto: "https"},
		{name: "forbidden origin", host: "localhost:8080", forwardedHost: "mcp.example.test:8443", proto: "https", origin: "https://attacker.test"},
		{name: "spoofed headers from untrusted peer", host: "localhost:8080", forwardedHost: "mcp.example.test:8443", proto: "https", origin: "https://mcp.example.test:8443"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := requestFor(tc.host, tc.forwardedHost, tc.proto, tc.origin)
			if tc.name == "spoofed headers from untrusted peer" {
				r.RemoteAddr = "203.0.113.8:43210"
			}
			got := serve(handler, r)
			if got.Code != http.StatusForbidden {
				t.Fatalf("status=%d want forbidden; body=%s", got.Code, got.Body.String())
			}
		})
	}

	withoutPublicURL := makeHandler("")
	for _, host := range []string{"localhost:8080", "127.0.0.1:8080", "[::1]:8080"} {
		r := requestFor(host, host, "http", "")
		r.Header.Set("X-Forwarded-For", "127.0.0.1")
		got := serve(withoutPublicURL, r)
		if got.Code == http.StatusForbidden {
			t.Errorf("default loopback authority %q was rejected: %s", host, got.Body.String())
		}
	}
	for _, host := range []string{"attacker.test:8080", "127.0.0.2:8080"} {
		got := serve(withoutPublicURL, requestFor(host, host, "http", ""))
		if got.Code != http.StatusForbidden {
			t.Errorf("unconfigured authority %q status=%d, want forbidden", host, got.Code)
		}
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
	credentials, err := mcp.NewCredentialStoreWithClock(newMCPRepository(t, database), func() time.Time { return clock })
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
