package mcp_test

import (
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"videocutlist/internal/mcp"
)

func TestTransportNumericCancellationAndActiveIDRelease(t *testing.T) {
	for _, test := range []struct {
		name       string
		requestID  string
		equivalent string
	}{
		{name: "decimal exponent", requestID: `1e3`, equivalent: `1000`},
		{name: "exact large integer", requestID: `9007199254740993`, equivalent: `90071992547409930e-1`},
	} {
		t.Run(test.name, func(t *testing.T) {
			credentials, secret, _ := transportCredentials(t, time.Hour)
			started := make(chan struct{})
			cancelled := make(chan struct{})
			release := make(chan struct{})
			var releaseOnce sync.Once
			defer releaseOnce.Do(func() { close(release) })
			handler := newTransport(t, mcp.TransportConfig{Enabled: true, Credentials: credentials, Tools: []mcp.Tool{{
				Name: "wait", Permission: mcp.PermissionMediaRead, InputSchema: map[string]any{"type": "object"},
				Resource: func(mcp.Context, json.RawMessage) (mcp.Resource, error) { return mcp.Resource{}, nil },
				Call: func(ctx mcp.Context, _ json.RawMessage) (mcp.ToolResult, error) {
					close(started)
					<-ctx.Request.Context().Done()
					close(cancelled)
					<-release
					return mcp.ToolResult{}, ctx.Request.Context().Err()
				},
			}}})
			session := initialize(t, handler, secret)
			responseDone := make(chan string, 1)
			go func() {
				response := serve(handler, sessionRequest(`{"jsonrpc":"2.0","id":`+test.requestID+`,"method":"tools/call","params":{"name":"wait","arguments":{}}}`, secret, session))
				responseDone <- response.Body.String()
			}()
			select {
			case <-started:
			case <-time.After(3 * time.Second):
				t.Fatal("tool did not start")
			}
			duplicate := serve(handler, sessionRequest(`{"jsonrpc":"2.0","id":`+test.equivalent+`,"method":"ping"}`, secret, session))
			if duplicate.Code != http.StatusBadRequest || !strings.Contains(duplicate.Body.String(), `"code":-32600`) {
				t.Fatalf("equivalent active ID status=%d body=%s", duplicate.Code, duplicate.Body.String())
			}
			malformedCancel := serve(handler, sessionRequest(`{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":true}}`, secret, session))
			if malformedCancel.Code >= http.StatusInternalServerError {
				t.Fatalf("malformed cancellation reference caused server failure: status=%d body=%s", malformedCancel.Code, malformedCancel.Body.String())
			}
			select {
			case <-cancelled:
				t.Fatal("malformed cancellation reference cancelled the active request")
			default:
			}
			cancel := serve(handler, sessionRequest(`{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":`+test.equivalent+`}}`, secret, session))
			if cancel.Code != http.StatusAccepted {
				t.Fatalf("cancel status=%d body=%s", cancel.Code, cancel.Body.String())
			}
			select {
			case <-cancelled:
			case <-time.After(3 * time.Second):
				t.Fatal("equivalent numeric cancellation did not cancel the tool context")
			}
			duplicateAfterCancel := serve(handler, sessionRequest(`{"jsonrpc":"2.0","id":`+test.equivalent+`,"method":"ping"}`, secret, session))
			if duplicateAfterCancel.Code != http.StatusBadRequest {
				t.Fatalf("cancelled but still-exiting request released numeric ID early: status=%d body=%s", duplicateAfterCancel.Code, duplicateAfterCancel.Body.String())
			}
			releaseOnce.Do(func() { close(release) })
			<-responseDone
			ping := serve(handler, sessionRequest(`{"jsonrpc":"2.0","id":`+test.equivalent+`,"method":"ping"}`, secret, session))
			if ping.Code != http.StatusOK || !strings.Contains(ping.Body.String(), `"id":`+test.equivalent) {
				t.Fatalf("released ID status=%d body=%s", ping.Code, ping.Body.String())
			}
		})
	}
}
