package mcp_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"videocutlist/internal/mcp"
)

func TestPinnedSDKClientInteroperatesWithHTTPTransport(t *testing.T) {
	credentials, secret, _ := transportCredentials(t, time.Hour)
	called := false
	tools := make([]mcp.Tool, 101)
	for i := range tools {
		name := fmt.Sprintf("safe_%03d", i)
		tools[i] = mcp.Tool{
			Name: name, Description: "safe test tool", Permission: mcp.PermissionMediaRead,
			InputSchema: map[string]any{"type": "object"},
			Resource:    func(mcp.Context, json.RawMessage) (mcp.Resource, error) { return mcp.Resource{}, nil },
			Call: func(mcp.Context, json.RawMessage) (mcp.ToolResult, error) {
				called = true
				return mcp.ToolResult{Content: []mcp.ToolContent{{Type: "text", Text: "called"}}}, nil
			},
		}
	}
	handler := newTransport(t, mcp.TransportConfig{Enabled: true, Credentials: credentials, Tools: tools})
	server := httptest.NewServer(handler)
	defer server.Close()

	clientHTTP := &http.Client{Transport: authenticatedTransport{base: http.DefaultTransport, token: secret}}
	client := sdk.NewClient(&sdk.Implementation{Name: "integration-test", Version: "1"}, &sdk.ClientOptions{Capabilities: &sdk.ClientCapabilities{}})
	session, err := client.Connect(t.Context(), &sdk.StreamableClientTransport{
		Endpoint: server.URL, HTTPClient: clientHTTP, DisableStandaloneSSE: true,
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = session.Close() }()
	result := session.InitializeResult()
	if result.ProtocolVersion != mcp.ProtocolVersion || result.Capabilities == nil || result.Capabilities.Tools == nil {
		t.Fatalf("unexpected initialization result: %#v", result)
	}
	if err := session.Ping(t.Context(), nil); err != nil {
		t.Fatalf("ping: %v", err)
	}

	var listed []string
	for tool, err := range session.Tools(t.Context(), nil) {
		if err != nil {
			t.Fatalf("list tools: %v", err)
		}
		listed = append(listed, tool.Name)
	}
	if len(listed) != len(tools) {
		t.Fatalf("listed %d tools, want %d", len(listed), len(tools))
	}
	seen := make(map[string]bool, len(listed))
	for _, name := range listed {
		if seen[name] {
			t.Fatalf("duplicate tool %q", name)
		}
		seen[name] = true
	}
	callResult, err := session.CallTool(t.Context(), &sdk.CallToolParams{Name: "safe_000", Arguments: map[string]any{}})
	if err != nil || !called || callResult == nil || callResult.IsError {
		t.Fatalf("call result=%#v called=%v err=%v", callResult, called, err)
	}

	oldID := session.ID()
	if oldID == "" {
		t.Fatal("client did not retain server session ID")
	}
	if err := session.Close(); err != nil {
		t.Fatalf("session deletion: %v", err)
	}
	// The SDK exposes deletion through ClientSession.Close; raw HTTP is used
	// only to verify that the deleted session cannot subsequently be reused.
	req, err := http.NewRequestWithContext(t.Context(), http.MethodPost, server.URL, strings.NewReader(`{"jsonrpc":"2.0","id":99,"method":"ping"}`))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+secret)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("MCP-Protocol-Version", mcp.ProtocolVersion)
	req.Header.Set("Mcp-Session-Id", oldID)
	response, err := clientHTTP.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusNotFound {
		t.Fatalf("deleted session reuse status=%d", response.StatusCode)
	}
}

type authenticatedTransport struct {
	base  http.RoundTripper
	token string
}

func (t authenticatedTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	request = request.Clone(request.Context())
	request.Header.Set("Authorization", "Bearer "+t.token)
	return t.base.RoundTrip(request)
}
