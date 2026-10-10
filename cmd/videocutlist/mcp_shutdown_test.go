package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"sync"
	"testing"
	"time"

	store "videocutlist/internal/db"
	"videocutlist/internal/mcp"
)

func TestShutdownHTTPServerGracefullyDrainsMCPCallBeforeCancellation(t *testing.T) {
	started := make(chan struct{})
	cancelled := make(chan struct{}, 1)
	release := make(chan struct{})
	var releaseOnce sync.Once
	defer releaseOnce.Do(func() { close(release) })
	transport, server, client, baseURL, secret := startMCPHTTPFixture(t, func(ctx mcp.Context, _ json.RawMessage) (mcp.ToolResult, error) {
		close(started)
		select {
		case <-ctx.Request.Context().Done():
			cancelled <- struct{}{}
			return mcp.ToolResult{}, ctx.Request.Context().Err()
		case <-release:
			return mcp.ToolResult{StructuredContent: map[string]any{"ok": true}}, nil
		}
	})
	sessionID := initializeMCPOverHTTP(t, client, baseURL, secret)
	callDone := startMCPCallOverHTTP(t, client, baseURL, secret, sessionID)
	<-started

	shutdownStarted := make(chan struct{})
	server.RegisterOnShutdown(func() { close(shutdownStarted) })
	shutdownDone := make(chan error, 1)
	gracefulContext, cancelGraceful := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancelGraceful()
	go func() { shutdownDone <- shutdownHTTPServer(server, transport, gracefulContext, 5*time.Second) }()
	select {
	case <-shutdownStarted:
	case <-time.After(5 * time.Second):
		t.Fatal("HTTP graceful shutdown did not start")
	}
	select {
	case <-cancelled:
		t.Fatal("MCP application work was cancelled before graceful HTTP drain")
	default:
	}
	releaseOnce.Do(func() { close(release) })
	select {
	case err := <-callDone:
		if err != nil {
			t.Fatalf("gracefully drained MCP request: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("gracefully drained MCP request did not finish")
	}
	select {
	case err := <-shutdownDone:
		if err != nil {
			t.Fatalf("graceful shutdown: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("graceful HTTP/MCP shutdown did not finish")
	}
}

func TestShutdownHTTPServerDeadlineCancelsMCPWorkAndWaitsForExit(t *testing.T) {
	started := make(chan struct{})
	cancelled := make(chan struct{}, 1)
	release := make(chan struct{})
	var releaseOnce sync.Once
	defer releaseOnce.Do(func() { close(release) })
	transport, server, client, baseURL, secret := startMCPHTTPFixture(t, func(ctx mcp.Context, _ json.RawMessage) (mcp.ToolResult, error) {
		close(started)
		<-ctx.Request.Context().Done()
		cancelled <- struct{}{}
		<-release
		return mcp.ToolResult{}, ctx.Request.Context().Err()
	})
	sessionID := initializeMCPOverHTTP(t, client, baseURL, secret)
	callDone := startMCPCallOverHTTP(t, client, baseURL, secret, sessionID)
	<-started

	gracefulContext, cancelGraceful := context.WithTimeout(t.Context(), 30*time.Millisecond)
	defer cancelGraceful()
	shutdownDone := make(chan error, 1)
	go func() { shutdownDone <- shutdownHTTPServer(server, transport, gracefulContext, 5*time.Second) }()
	select {
	case <-cancelled:
	case <-time.After(5 * time.Second):
		t.Fatal("deadline shutdown did not cancel application work")
	}
	select {
	case err := <-shutdownDone:
		t.Fatalf("shutdown returned before blocked application work exited: %v", err)
	default:
	}
	releaseOnce.Do(func() { close(release) })
	select {
	case err := <-shutdownDone:
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("deadline shutdown error=%v, want HTTP deadline reported", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("deadline shutdown did not finish after application work exited")
	}
	select {
	case <-callDone:
	case <-time.After(5 * time.Second):
		t.Fatal("deadline-closed HTTP request did not return")
	}
}

func startMCPHTTPFixture(t *testing.T, call func(mcp.Context, json.RawMessage) (mcp.ToolResult, error)) (*mcp.Transport, *http.Server, *http.Client, string, string) {
	t.Helper()
	database, err := store.OpenDatabase(t.Context(), t.TempDir()+"/mcp.db")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	mcpStorage, err := store.NewMCPStorage(database)
	if err != nil {
		t.Fatal(err)
	}
	credentials, err := mcp.NewCredentialStore(mcpStorage)
	if err != nil {
		t.Fatal(err)
	}
	expires := time.Now().Add(time.Hour)
	created, err := credentials.Create(t.Context(), mcp.CredentialInput{
		Name: "shutdown", Permissions: []mcp.Permission{mcp.PermissionMediaRead},
		MediaScope: mcp.MediaScope{Kind: mcp.MediaScopeAll}, ProjectScope: mcp.ProjectScope{Kind: mcp.ProjectScopeAll}, ExpiresAt: &expires,
	})
	if err != nil {
		t.Fatal(err)
	}
	transport, err := mcp.NewTransport(mcp.TransportConfig{Enabled: true, Credentials: credentials, Tools: []mcp.Tool{{
		Name: "block", Permission: mcp.PermissionMediaRead, InputSchema: map[string]any{"type": "object"},
		Resource: func(mcp.Context, json.RawMessage) (mcp.Resource, error) { return mcp.Resource{}, nil },
		Call:     call,
	}}})
	if err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: transport}
	serveDone := make(chan error, 1)
	go func() { serveDone <- server.Serve(listener) }()
	t.Cleanup(func() {
		_ = server.Close()
		select {
		case <-serveDone:
		case <-time.After(5 * time.Second):
			t.Error("HTTP server Serve goroutine did not exit")
		}
		cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := transport.Shutdown(cleanup); err != nil {
			t.Errorf("MCP fixture shutdown: %v", err)
		}
	})
	return transport, server, &http.Client{}, "http://" + listener.Addr().String() + "/mcp", created.Secret
}

func initializeMCPOverHTTP(t *testing.T, client *http.Client, endpoint, secret string) string {
	t.Helper()
	response, err := mcpPost(client, endpoint, secret, "", `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"shutdown-test","version":"1"}}}`)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(response.Body)
		t.Fatalf("MCP initialize status=%d body=%s", response.StatusCode, body)
	}
	return response.Header.Get("Mcp-Session-Id")
}

func startMCPCallOverHTTP(t *testing.T, client *http.Client, endpoint, secret, sessionID string) <-chan error {
	t.Helper()
	done := make(chan error, 1)
	go func() {
		response, err := mcpPost(client, endpoint, secret, sessionID, `{"jsonrpc":"2.0","id":"shutdown-call","method":"tools/call","params":{"name":"block","arguments":{}}}`)
		if err == nil {
			_, readErr := io.Copy(io.Discard, response.Body)
			closeErr := response.Body.Close()
			if response.StatusCode != http.StatusOK {
				err = errors.New("MCP tool call returned HTTP " + response.Status)
			}
			err = errors.Join(err, readErr, closeErr)
		}
		done <- err
	}()
	return done
}

func mcpPost(client *http.Client, endpoint, secret, sessionID, body string) (*http.Response, error) {
	request, err := http.NewRequest(http.MethodPost, endpoint, bytes.NewBufferString(body))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+secret)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json, text/event-stream")
	if sessionID != "" {
		request.Header.Set("Mcp-Session-Id", sessionID)
		request.Header.Set("MCP-Protocol-Version", mcp.ProtocolVersion)
	}
	return client.Do(request)
}
