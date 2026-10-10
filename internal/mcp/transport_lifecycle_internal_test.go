package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"

	store "videocutlist/internal/db"
)

func TestTransportSocketDisconnectKeepsAdmissionAndNumericIDUntilToolExit(t *testing.T) {
	started := make(chan struct{})
	cancelled := make(chan struct{})
	release := make(chan struct{})
	var releaseOnce sync.Once
	defer releaseOnce.Do(func() { close(release) })
	transport, credentials, secret := lifecycleTransport(t, TransportConfig{
		MaxConcurrentRequests: 1,
		Tools: []Tool{{
			Name: "wait", Permission: PermissionMediaRead, InputSchema: map[string]any{"type": "object"},
			Resource: func(Context, json.RawMessage) (Resource, error) { return Resource{}, nil },
			Call: func(ctx Context, _ json.RawMessage) (ToolResult, error) {
				close(started)
				<-ctx.Request.Context().Done()
				close(cancelled)
				<-release
				return ToolResult{}, ctx.Request.Context().Err()
			},
		}},
	})
	sessionID := initializeBudgetSession(t, transport, secret)
	credential, err := credentials.Authenticate(t.Context(), secret)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(transport)
	client := server.Client()
	t.Cleanup(func() {
		server.CloseClientConnections()
		server.Close()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := transport.Shutdown(ctx); err != nil {
			t.Errorf("transport cleanup: %v", err)
		}
	})
	requestContext, cancelRequest := context.WithCancel(t.Context())
	defer cancelRequest()
	request, err := http.NewRequestWithContext(requestContext, http.MethodPost, server.URL+"/mcp",
		strings.NewReader(`{"jsonrpc":"2.0","id":9007199254740993,"method":"tools/call","params":{"name":"wait","arguments":{}}}`))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer "+secret)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json, text/event-stream")
	request.Header.Set("MCP-Protocol-Version", ProtocolVersion)
	request.Header.Set("Mcp-Session-Id", sessionID)
	responseDone := make(chan struct{})
	go func() {
		response, err := client.Do(request)
		responseBody := ""
		if response != nil {
			body, _ := io.ReadAll(response.Body)
			responseBody = string(body)
			_ = response.Body.Close()
		}
		if err == nil {
			t.Errorf("cancelled socket request unexpectedly received a response: status=%d body=%s", response.StatusCode, responseBody)
		}
		close(responseDone)
	}()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("socket request did not enter tool")
	}
	cancelRequest()
	select {
	case <-cancelled:
	case <-time.After(5 * time.Second):
		t.Fatal("client socket cancellation did not reach application tool context")
	}
	select {
	case <-responseDone:
	case <-time.After(5 * time.Second):
		t.Fatal("client request did not observe socket cancellation")
	}
	numericIDKey, ok := canonicalNumericID([]byte("9007199254740993"))
	if !ok {
		t.Fatal("test numeric request ID did not canonicalize")
	}
	transport.mu.Lock()
	if transport.workRequests[credential.ID] != 1 || transport.numericIDs[credential.ID+"\x00"+sessionID][numericIDKey] == "" || transport.sessions[sessionID].inFlight != 1 || len(transport.activeCalls) != 1 {
		got := fmt.Sprintf("work=%d ids=%v inFlight=%d active=%d", transport.workRequests[credential.ID], transport.numericIDs[credential.ID+"\x00"+sessionID], transport.sessions[sessionID].inFlight, len(transport.activeCalls))
		transport.mu.Unlock()
		t.Fatalf("cancelled socket request released ownership before tool exit: %s", got)
	}
	transport.mu.Unlock()
	transport.mu.Lock()
	var dispatchDone <-chan struct{}
	for association := range transport.activeCalls {
		dispatchDone = association.dispatchDone
	}
	transport.mu.Unlock()
	if dispatchDone == nil {
		t.Fatal("socket request lost its active association before tool exit")
	}
	releaseOnce.Do(func() { close(release) })
	select {
	case <-dispatchDone:
	case <-time.After(5 * time.Second):
		t.Fatal("socket request dispatch did not finish after tool exit")
	}
	transport.mu.Lock()
	defer transport.mu.Unlock()
	if transport.workRequests[credential.ID] != 0 || len(transport.numericIDs[credential.ID+"\x00"+sessionID]) != 0 || transport.sessions[sessionID].inFlight != 0 || len(transport.activeCalls) != 0 {
		t.Fatal("tool exit did not release admission, numeric ID, session lease, and association")
	}
}

func TestTransportHTTPDisconnectKeepsAdmissionAndNumericIDUntilToolExit(t *testing.T) {
	started := make(chan struct{})
	cancelled := make(chan struct{})
	release := make(chan struct{})
	var releaseOnce sync.Once
	defer releaseOnce.Do(func() { close(release) })
	transport, credentials, secret := lifecycleTransport(t, TransportConfig{
		MaxConcurrentRequests: 1,
		Tools: []Tool{{
			Name: "wait", Permission: PermissionMediaRead, InputSchema: map[string]any{"type": "object"},
			Resource: func(Context, json.RawMessage) (Resource, error) { return Resource{}, nil },
			Call: func(ctx Context, _ json.RawMessage) (ToolResult, error) {
				close(started)
				<-ctx.Request.Context().Done()
				close(cancelled)
				<-release
				return ToolResult{}, ctx.Request.Context().Err()
			},
		}},
	})
	sessionID := initializeBudgetSession(t, transport, secret)
	credential, err := credentials.Authenticate(t.Context(), secret)
	if err != nil {
		t.Fatal(err)
	}
	request := budgetRequest(http.MethodPost, secret, sessionID, `{"jsonrpc":"2.0","id":9007199254740993,"method":"tools/call","params":{"name":"wait","arguments":{}}}`)
	requestContext, cancelRequest := context.WithCancel(t.Context())
	request = request.WithContext(requestContext)
	responseDone := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		response := httptest.NewRecorder()
		transport.ServeHTTP(response, request)
		responseDone <- response
	}()
	<-started
	cancelRequest()
	<-cancelled

	numericIDKey, ok := canonicalNumericID([]byte("9007199254740993"))
	if !ok {
		t.Fatal("test numeric request ID did not canonicalize")
	}
	transport.mu.Lock()
	var associationToken string
	for association := range transport.activeCalls {
		associationToken = association.token
	}
	if transport.workRequests[credential.ID] != 1 || transport.numericIDs[credential.ID+"\x00"+sessionID][numericIDKey] == "" || transport.sessions[sessionID].inFlight != 1 || len(transport.activeCalls) != 1 {
		transport.mu.Unlock()
		t.Fatal("cancelled but non-exited tool released application ownership early")
	}
	transport.mu.Unlock()

	releaseOnce.Do(func() { close(release) })
	var response *httptest.ResponseRecorder
	select {
	case response = <-responseDone:
	case <-time.After(5 * time.Second):
		t.Fatal("HTTP request did not finish after the tool exited")
	}
	if strings.Contains(response.Body.String(), associationToken) || response.Header().Get(associationHeader) != "" {
		t.Fatal("private request association token leaked into the HTTP response")
	}
	transport.mu.Lock()
	defer transport.mu.Unlock()
	if transport.workRequests[credential.ID] != 0 || len(transport.numericIDs[credential.ID+"\x00"+sessionID]) != 0 || transport.sessions[sessionID].inFlight != 0 || len(transport.activeCalls) != 0 {
		t.Fatal("tool exit did not release admission, numeric ID, session lease, and association")
	}
}

func TestTransportShutdownCancelsAndReportsContextIgnoringTool(t *testing.T) {
	started := make(chan struct{})
	cancelled := make(chan struct{})
	release := make(chan struct{})
	var releaseOnce sync.Once
	defer releaseOnce.Do(func() { close(release) })
	transport, credentials, secret := lifecycleTransport(t, TransportConfig{
		MaxConcurrentRequests: 1,
		Tools: []Tool{{
			Name: "ignore_cancel", Permission: PermissionMediaRead, InputSchema: map[string]any{"type": "object"},
			Resource: func(Context, json.RawMessage) (Resource, error) { return Resource{}, nil },
			Call: func(ctx Context, _ json.RawMessage) (ToolResult, error) {
				close(started)
				<-ctx.Request.Context().Done()
				close(cancelled)
				<-release
				return ToolResult{}, nil
			},
		}},
	})
	sessionID := initializeBudgetSession(t, transport, secret)
	credential, err := credentials.Authenticate(t.Context(), secret)
	if err != nil {
		t.Fatal(err)
	}
	responseDone := make(chan struct{})
	go func() {
		response := httptest.NewRecorder()
		transport.ServeHTTP(response, budgetRequest(http.MethodPost, secret, sessionID, `{"jsonrpc":"2.0","id":"held","method":"tools/call","params":{"name":"ignore_cancel","arguments":{}}}`))
		close(responseDone)
	}()
	<-started

	shutdownContext, cancelShutdown := context.WithTimeout(t.Context(), 30*time.Millisecond)
	defer cancelShutdown()
	shutdownErr := transport.Shutdown(shutdownContext)
	if !errors.Is(shutdownErr, context.DeadlineExceeded) {
		t.Fatalf("shutdown error = %v, want bounded deadline failure", shutdownErr)
	}
	<-cancelled
	newWork := httptest.NewRecorder()
	transport.ServeHTTP(newWork, budgetRequest(http.MethodPost, secret, sessionID, `{"jsonrpc":"2.0","id":8,"method":"ping"}`))
	if newWork.Code != http.StatusServiceUnavailable {
		t.Fatalf("shutdown accepted new work: status=%d body=%s", newWork.Code, newWork.Body.String())
	}
	transport.mu.Lock()
	if transport.workRequests[credential.ID] != 1 || len(transport.activeCalls) != 1 || len(transport.associations) != 0 || transport.sessions[sessionID] == nil {
		transport.mu.Unlock()
		t.Fatal("shutdown released ownership while a context-ignoring tool remained live")
	}
	transport.mu.Unlock()

	releaseOnce.Do(func() { close(release) })
	select {
	case <-responseDone:
	case <-time.After(5 * time.Second):
		t.Fatal("context-ignoring tool did not drain after explicit release")
	}
	cleanupContext, cancelCleanup := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancelCleanup()
	if err := transport.Shutdown(cleanupContext); err != nil {
		t.Fatalf("second shutdown after tool exit: %v", err)
	}
	transport.mu.Lock()
	defer transport.mu.Unlock()
	if transport.workRequests[credential.ID] != 0 || len(transport.activeCalls) != 0 || len(transport.associations) != 0 {
		t.Fatal("late tool exit left admission or association state")
	}
}

func TestTransportSealedAssociationCannotBeClaimed(t *testing.T) {
	transport := &Transport{
		associations: make(map[string]*requestAssociation), activeCalls: make(map[*requestAssociation]struct{}),
		sessions: map[string]*session{"session": {credentialID: "credential"}},
	}
	association := &requestAssociation{
		token: "unpredictable", sessionID: "session", credentialID: "credential",
		appDone: make(chan struct{}), dispatchDone: make(chan struct{}), requestCtx: context.Background(),
	}
	transport.associations[association.token] = association
	transport.activeCalls[association] = struct{}{}
	transport.sealAssociation(association)
	transport.finishAssociationDispatch(association)
	request := &sdk.CallToolRequest{Extra: &sdk.RequestExtra{Header: http.Header{
		associationHeader: {association.token}, "Mcp-Session-Id": {association.sessionID},
	}}}
	if _, _, _, ok := transport.claimAssociation(context.Background(), request); ok {
		t.Fatal("sealed association was claimed after dispatch ended")
	}
	if len(transport.associations) != 0 || len(transport.activeCalls) != 0 {
		t.Fatal("sealed association retained lookup or active-call state")
	}
}

func lifecycleTransport(t *testing.T, config TransportConfig) (*Transport, *CredentialStore, string) {
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
	credentials, err := NewCredentialStore(mcpStorage)
	if err != nil {
		t.Fatal(err)
	}
	expires := time.Now().Add(time.Hour)
	created, err := credentials.Create(t.Context(), CredentialInput{
		Name: "lifecycle", Permissions: []Permission{PermissionMediaRead},
		MediaScope: MediaScope{Kind: MediaScopeAll}, ProjectScope: ProjectScope{Kind: ProjectScopeAll}, ExpiresAt: &expires,
	})
	if err != nil {
		t.Fatal(err)
	}
	config.Enabled = true
	config.Credentials = credentials
	transport, err := NewTransport(config)
	if err != nil {
		t.Fatal(err)
	}
	return transport, credentials, created.Secret
}
