package mcp_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"videocutlist/internal/mcp"
)

const privateAssociationHeader = "X-Videocutlist-MCP-Association"

func TestTransportCombinesIndependentHTTPContextsAndHidesAssociationHeader(t *testing.T) {
	credentials, secret, _ := transportCredentials(t, time.Hour)
	started := make(chan string, 2)
	cancelledA := make(chan struct{}, 1)
	releaseA, releaseB := make(chan struct{}), make(chan struct{})
	var releaseAOnce, releaseBOnce sync.Once
	defer releaseAOnce.Do(func() { close(releaseA) })
	defer releaseBOnce.Do(func() { close(releaseB) })
	observed := make(chan struct {
		tag       string
		private   bool
		authority string
		sessionID string
	}, 2)
	transport, err := mcp.NewTransport(mcp.TransportConfig{
		Enabled: true, Credentials: credentials, MaxConcurrentRequests: 2,
		Tools: []mcp.Tool{{
			Name: "wait", Permission: mcp.PermissionMediaRead, InputSchema: map[string]any{"type": "object"},
			Resource: func(mcp.Context, json.RawMessage) (mcp.Resource, error) { return mcp.Resource{}, nil },
			Call: func(ctx mcp.Context, raw json.RawMessage) (mcp.ToolResult, error) {
				var args struct {
					Tag string `json:"tag"`
				}
				if err := json.Unmarshal(raw, &args); err != nil {
					return mcp.ToolResult{}, err
				}
				private := false
				for key := range ctx.Request.Header {
					if strings.EqualFold(key, privateAssociationHeader) {
						private = true
					}
				}
				observed <- struct {
					tag       string
					private   bool
					authority string
					sessionID string
				}{args.Tag, private, ctx.Request.Header.Get("Authorization"), ctx.Request.Header.Get("Mcp-Session-Id")}
				started <- args.Tag
				if args.Tag == "A" {
					<-ctx.Request.Context().Done()
					cancelledA <- struct{}{}
					<-releaseA
					return mcp.ToolResult{}, ctx.Request.Context().Err()
				}
				<-releaseB
				return mcp.ToolResult{StructuredContent: map[string]any{"tag": args.Tag}}, nil
			},
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	sessionID := initialize(t, transport, secret)
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = transport.Shutdown(cleanup)
	}()

	start := func(ctx context.Context, id, tag string) <-chan int {
		done := make(chan int, 1)
		request := sessionRequest(`{"jsonrpc":"2.0","id":`+id+`,"method":"tools/call","params":{"name":"wait","arguments":{"tag":"`+tag+`"}}}`, secret, sessionID).WithContext(ctx)
		// Several attacker-supplied spellings and values must all be replaced.
		request.Header[privateAssociationHeader] = []string{"forged-canonical"}
		request.Header["x-videocutlist-mcp-association"] = []string{"forged-lower"}
		request.Header["X-VIDEOCUTLIST-MCP-ASSOCIATION"] = []string{"forged-upper"}
		go func() {
			response := httptest.NewRecorder()
			transport.ServeHTTP(response, request)
			done <- response.Code
		}()
		return done
	}

	ctxA, cancelA := context.WithCancel(t.Context())
	defer cancelA()
	doneA := start(ctxA, `9007199254740993`, "A")
	doneB := start(t.Context(), `9007199254740995`, "B")
	for range 2 {
		select {
		case <-started:
		case <-time.After(5 * time.Second):
			t.Fatal("both same-session tools did not start")
		}
	}
	for range 2 {
		select {
		case item := <-observed:
			if item.private || item.authority != "Bearer "+secret || item.sessionID != sessionID {
				t.Fatalf("application received unsafe or incomplete request headers: %#v", item)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("tool did not report its application-visible headers")
		}
	}

	cancelA()
	select {
	case <-cancelledA:
	case <-time.After(5 * time.Second):
		t.Fatal("originating HTTP cancellation did not reach tool A")
	}
	releaseAOnce.Do(func() { close(releaseA) })
	select {
	case <-doneA:
	case <-time.After(5 * time.Second):
		t.Fatal("tool A did not exit after controlled release")
	}
	select {
	case <-doneB:
		t.Fatal("cancelling HTTP request A unexpectedly completed request B")
	default:
	}
	releaseBOnce.Do(func() { close(releaseB) })
	select {
	case code := <-doneB:
		if code != http.StatusOK {
			t.Fatalf("request B status=%d", code)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("independent request B did not finish")
	}
}

func TestTransportSessionDeleteCancelsOnlyCallsInDeletedSession(t *testing.T) {
	credentials, secret, _ := transportCredentials(t, time.Hour)
	started := make(chan string, 2)
	cancelled := make(chan string, 2)
	releaseOne, releaseTwo := make(chan struct{}), make(chan struct{})
	var releaseOneOnce, releaseTwoOnce sync.Once
	defer releaseOneOnce.Do(func() { close(releaseOne) })
	defer releaseTwoOnce.Do(func() { close(releaseTwo) })
	sessionOne := ""
	transport := newTransport(t, mcp.TransportConfig{
		Enabled: true, Credentials: credentials,
		Tools: []mcp.Tool{{
			Name: "wait", Permission: mcp.PermissionMediaRead, InputSchema: map[string]any{"type": "object"},
			Resource: func(mcp.Context, json.RawMessage) (mcp.Resource, error) { return mcp.Resource{}, nil },
			Call: func(ctx mcp.Context, _ json.RawMessage) (mcp.ToolResult, error) {
				sessionID := ctx.Request.Header.Get("Mcp-Session-Id")
				started <- sessionID
				if sessionID == sessionOne {
					<-ctx.Request.Context().Done()
					cancelled <- sessionID
					<-releaseOne
					return mcp.ToolResult{}, ctx.Request.Context().Err()
				}
				select {
				case <-ctx.Request.Context().Done():
					cancelled <- sessionID
					<-releaseTwo
					return mcp.ToolResult{}, ctx.Request.Context().Err()
				case <-releaseTwo:
					return mcp.ToolResult{}, nil
				}
			},
		}},
	})
	sessionOne = initialize(t, transport, secret)
	sessionTwo := initialize(t, transport, secret)
	if sessionOne == sessionTwo {
		t.Fatal("initialization returned duplicate session IDs")
	}
	start := func(sessionID string) <-chan int {
		done := make(chan int, 1)
		request := sessionRequest(`{"jsonrpc":"2.0","id":"`+sessionID+`-call","method":"tools/call","params":{"name":"wait","arguments":{}}}`, secret, sessionID)
		go func() {
			response := serve(transport, request)
			done <- response.Code
		}()
		return done
	}
	oneDone := start(sessionOne)
	twoDone := start(sessionTwo)
	for range 2 {
		select {
		case <-started:
		case <-time.After(5 * time.Second):
			t.Fatal("both session calls did not start")
		}
	}
	deleteDone := make(chan int, 1)
	go func() {
		deleteDone <- serve(transport, newDeleteSessionRequest(secret, sessionOne)).Code
	}()
	select {
	case got := <-cancelled:
		if got != sessionOne {
			t.Fatalf("DELETE cancelled unrelated session %q, want %q", got, sessionOne)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("DELETE did not cancel its active application call")
	}
	select {
	case got := <-cancelled:
		t.Fatalf("DELETE also cancelled unrelated session %q", got)
	default:
	}
	releaseOneOnce.Do(func() { close(releaseOne) })
	select {
	case status := <-deleteDone:
		if status != http.StatusNoContent {
			t.Fatalf("DELETE status=%d, want 204", status)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("DELETE did not complete after its application call exited")
	}
	select {
	case <-oneDone:
	case <-time.After(5 * time.Second):
		t.Fatal("deleted-session call did not return")
	}
	select {
	case <-twoDone:
		t.Fatal("unrelated session call unexpectedly exited")
	default:
	}
	releaseTwoOnce.Do(func() { close(releaseTwo) })
	select {
	case <-twoDone:
	case <-time.After(5 * time.Second):
		t.Fatal("unrelated session call did not finish")
	}
}
