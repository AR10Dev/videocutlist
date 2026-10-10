package mcp

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/modelcontextprotocol/go-sdk/jsonrpc"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"

	jobs "videocutlist/internal/jobs"
	jobqueue "videocutlist/internal/jobs/model"
)

const (
	ProtocolVersion              = "2025-06-18"
	maxRequestBytes              = 1 << 20
	maxResultBytes               = 1 << 20
	maxToolPage                  = 100
	maxControlConcurrentRequests = 1
	auditWriteTimeout            = 2 * time.Second
	associationHeader            = "X-Videocutlist-MCP-Association"
)

type RequestInfo struct {
	ClientIP    net.IP
	Host, Proto string
}

type Tool struct {
	Name, Description string
	InputSchema       map[string]any
	Permission        Permission
	Resource          func(Context, json.RawMessage) (Resource, error)
	Call              func(Context, json.RawMessage) (ToolResult, error)
}

// Context is the authenticated, scoped identity supplied to a tool call.
type Context struct {
	Request    *http.Request
	Credential Credential
}
type ToolResult struct {
	Content           []ToolContent  `json:"content"`
	StructuredContent map[string]any `json:"structuredContent,omitempty"`
	IsError           bool           `json:"isError,omitempty"`
}
type ToolContent struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

type TransportConfig struct {
	Enabled                                               bool
	EnabledFunc                                           func() bool
	Credentials                                           *CredentialStore
	Tools                                                 []Tool
	AllowedOrigins                                        []string
	PublicBaseURL                                         string
	RequestInfo                                           func(*http.Request) RequestInfo
	MaxConcurrentRequests, RequestsPerMinute, MaxSessions int
	SessionTTL                                            time.Duration
	Now                                                   func() time.Time
	Logger                                                *log.Logger
}

// Transport owns MCP admission, application cancellation, and session shutdown.
type Transport struct {
	config          TransportConfig
	allowed         map[string]struct{}
	publicAuthority string
	handler         http.Handler
	mu              sync.Mutex
	sessions        map[string]*session
	rates           map[string]rate
	workRequests    map[string]int
	controlRequests map[string]int
	numericIDs      map[string]map[string]string
	associations    map[string]*requestAssociation
	activeCalls     map[*requestAssociation]struct{}
	workChanged     chan struct{}
	shuttingDown    bool
}

type requestAssociation struct {
	token        string
	requestCtx   context.Context
	credentialID string
	sessionID    string
	sealed       bool
	claimed      bool
	appCancel    context.CancelFunc
	appDone      chan struct{}
	dispatchDone chan struct{}
}

type session struct {
	credentialID string
	lastUsed     time.Time
	server       *sdk.Server
	initializing bool
	initialized  bool
	closing      bool
	inFlight     int
}
type rate struct {
	window time.Time
	count  int
}
type admissionKey struct{}
type sessionAdmission struct {
	credential  Credential
	id          string
	server      *sdk.Server
	association *requestAssociation
}

func NewTransport(config TransportConfig) (*Transport, error) {
	if config.Credentials == nil {
		return nil, errors.New("mcp credential store is required")
	}
	if config.MaxConcurrentRequests == 0 {
		config.MaxConcurrentRequests = 4
	}
	if config.RequestsPerMinute == 0 {
		config.RequestsPerMinute = 120
	}
	if config.MaxSessions == 0 {
		config.MaxSessions = 1024
	}
	if config.SessionTTL == 0 {
		config.SessionTTL = time.Hour
	}
	if config.Now == nil {
		config.Now = time.Now
	}
	if config.MaxConcurrentRequests < 1 || config.RequestsPerMinute < 1 || config.MaxSessions < 1 || config.SessionTTL < time.Minute {
		return nil, errors.New("invalid mcp transport limits")
	}
	t := &Transport{
		config: config, allowed: make(map[string]struct{}), sessions: make(map[string]*session),
		rates: make(map[string]rate), workRequests: make(map[string]int), controlRequests: make(map[string]int), numericIDs: make(map[string]map[string]string),
		associations: make(map[string]*requestAssociation), activeCalls: make(map[*requestAssociation]struct{}),
		workChanged: make(chan struct{}, 1),
	}
	for _, origin := range config.AllowedOrigins {
		t.allowed[origin] = struct{}{}
	}
	if config.PublicBaseURL != "" {
		public, err := url.Parse(config.PublicBaseURL)
		if err != nil || (public.Scheme != "http" && public.Scheme != "https") || public.Host == "" || public.User != nil {
			return nil, errors.New("invalid MCP public base URL")
		}
		t.publicAuthority = public.Host
	}
	t.handler = sdk.NewStreamableHTTPHandler(t.server, &sdk.StreamableHTTPOptions{
		JSONResponse: true, SessionTimeout: config.SessionTTL, MaxRequestBodyBytes: maxRequestBytes,
		// Our host guard below permits the explicitly configured public authority
		// for trusted reverse proxies without allowing arbitrary localhost Hosts.
		DisableLocalhostProtection: t.publicAuthority != "",
	})
	return t, nil
}

func (t *Transport) isShuttingDown() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.shuttingDown
}

// Shutdown rejects new MCP requests, cancels admitted application calls, waits
// for their actual exit, and then closes SDK sessions. The caller supplies the
// bounded cleanup deadline; context-ignoring tools remain charged until exit.
func (t *Transport) Shutdown(ctx context.Context) error {
	t.mu.Lock()
	t.shuttingDown = true
	calls := make([]*requestAssociation, 0, len(t.activeCalls))
	cancels := make([]context.CancelFunc, 0, len(t.activeCalls))
	for association := range t.activeCalls {
		association.sealed = true
		delete(t.associations, association.token)
		calls = append(calls, association)
		if association.claimed && association.appCancel != nil {
			cancels = append(cancels, association.appCancel)
		}
	}
	t.mu.Unlock()
	for _, cancel := range cancels {
		cancel()
	}
	for _, association := range calls {
		select {
		case <-association.dispatchDone:
		case <-ctx.Done():
			return fmt.Errorf("wait for MCP application calls: %w", ctx.Err())
		}
	}
	if err := t.waitForAdmissions(ctx); err != nil {
		return err
	}
	t.mu.Lock()
	sessions := make(map[string]*session, len(t.sessions))
	for id, entry := range t.sessions {
		entry.closing = true
		sessions[id] = entry
	}
	t.mu.Unlock()
	for id, entry := range sessions {
		closeServerSession(entry.server, id)
		t.mu.Lock()
		if t.sessions[id] == entry {
			delete(t.sessions, id)
		}
		t.mu.Unlock()
	}
	return nil
}

func (t *Transport) waitForAdmissions(ctx context.Context) error {
	for {
		t.mu.Lock()
		active := len(t.workRequests) != 0 || len(t.controlRequests) != 0
		changed := t.workChanged
		t.mu.Unlock()
		if !active {
			return nil
		}
		select {
		case <-changed:
		case <-ctx.Done():
			return fmt.Errorf("wait for MCP HTTP admissions: %w", ctx.Err())
		}
	}
}

func (t *Transport) notifyWorkChanged() {
	select {
	case t.workChanged <- struct{}{}:
	default:
	}
}

func (t *Transport) cancelSessionCalls(ctx context.Context, sessionID string) error {
	t.mu.Lock()
	entry := t.sessions[sessionID]
	if entry == nil {
		t.mu.Unlock()
		return nil
	}
	entry.closing = true
	var calls []*requestAssociation
	var cancels []context.CancelFunc
	for association := range t.activeCalls {
		if association.sessionID != sessionID {
			continue
		}
		association.sealed = true
		delete(t.associations, association.token)
		calls = append(calls, association)
		if association.claimed && association.appCancel != nil {
			cancels = append(cancels, association.appCancel)
		}
	}
	t.mu.Unlock()
	for _, cancel := range cancels {
		cancel()
	}
	for _, association := range calls {
		select {
		case <-association.dispatchDone:
		case <-ctx.Done():
			t.mu.Lock()
			if current := t.sessions[sessionID]; current == entry {
				current.closing = false
			}
			t.mu.Unlock()
			return fmt.Errorf("wait for MCP session calls: %w", ctx.Err())
		}
	}
	return nil
}

func (t *Transport) enabled() bool {
	if t.config.EnabledFunc != nil {
		return t.config.EnabledFunc()
	}
	return t.config.Enabled
}

// ServeHTTP enforces application security and budgets; the SDK owns JSON-RPC,
// protocol negotiation, discovery, pagination and the transport lifecycle.
func (t *Transport) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// This defer is registered before the session lease; it closes dispatchDone
	// only after all inner admission and numeric-ID defers have released ownership.
	var admission *sessionAdmission
	defer func() {
		if admission != nil && admission.association != nil {
			t.finishAssociationDispatch(admission.association)
		}
	}()
	if t.isShuttingDown() {
		http.Error(w, "MCP server is shutting down", http.StatusServiceUnavailable)
		return
	}
	if !t.enabled() {
		http.NotFound(w, r)
		return
	}
	if r.Method != http.MethodPost && r.Method != http.MethodDelete {
		w.Header().Set("Allow", "POST, DELETE")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !t.validTransport(r, t.requestInfo(r)) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	token, ok := bearerToken(r.Header.Values("Authorization"))
	if !ok {
		unauthorized(w)
		return
	}
	credential, err := t.config.Credentials.Authenticate(r.Context(), token)
	if err != nil {
		unauthorized(w)
		return
	}
	if !t.allowRequest(credential.ID) {
		w.Header().Set("Retry-After", "60")
		http.Error(w, "rate limit exceeded", http.StatusTooManyRequests)
		return
	}
	values := r.Header.Values("Mcp-Session-Id")
	sessionID := ""
	if len(values) > 0 || r.Method == http.MethodDelete {
		if !t.validSession(r, credential.ID, r.Method != http.MethodDelete) {
			http.NotFound(w, r)
			return
		}
		sessionID = values[0]
		if r.Method != http.MethodDelete {
			defer t.releaseSessionRequest(sessionID)
		}
		if r.Header.Get("MCP-Protocol-Version") != ProtocolVersion {
			http.Error(w, "Unsupported MCP protocol version", http.StatusBadRequest)
			return
		}
	}
	if r.Method == http.MethodDelete {
		if !t.acquireControl(credential.ID) {
			writeBusy(w)
			return
		}
		defer t.releaseControl(credential.ID)
		if err := t.cancelSessionCalls(r.Context(), sessionID); err != nil {
			http.Error(w, "MCP session is still draining", http.StatusServiceUnavailable)
			return
		}
		t.handler.ServeHTTP(w, r)
		t.removeSession(sessionID)
		return
	}
	if len(values) == 0 && !t.hasSessionCapacity(credential.ID) {
		http.Error(w, "Session capacity reached", http.StatusServiceUnavailable)
		return
	}
	admission = &sessionAdmission{credential: credential}
	r = r.WithContext(context.WithValue(r.Context(), admissionKey{}, admission))
	t.serveSDK(w, r)
	if admission.id != "" {
		t.finishInitialization(admission.id)
	}
}

func removeHeaderCaseInsensitive(header http.Header, name string) {
	for key := range header {
		if strings.EqualFold(key, name) {
			delete(header, key)
		}
	}
}

func headerValuesCaseInsensitive(header http.Header, name string) []string {
	var values []string
	for key, entries := range header {
		if strings.EqualFold(key, name) {
			values = append(values, entries...)
		}
	}
	return values
}

func (t *Transport) dispatchSDK(w http.ResponseWriter, r *http.Request, method string) {
	if method != "tools/call" {
		t.handler.ServeHTTP(w, r)
		return
	}
	admission := r.Context().Value(admissionKey{}).(*sessionAdmission)
	var random [24]byte
	if _, err := rand.Read(random[:]); err != nil {
		http.Error(w, "Internal error", http.StatusInternalServerError)
		return
	}
	token := base64.RawURLEncoding.EncodeToString(random[:])
	sessionValues := r.Header.Values("Mcp-Session-Id")
	if len(sessionValues) != 1 || sessionValues[0] == "" {
		http.Error(w, "Invalid MCP session", http.StatusNotFound)
		return
	}
	association := &requestAssociation{
		token: token, requestCtx: r.Context(), credentialID: admission.credential.ID,
		sessionID: sessionValues[0], appDone: make(chan struct{}), dispatchDone: make(chan struct{}),
	}
	t.mu.Lock()
	entry := t.sessions[association.sessionID]
	if t.shuttingDown || entry == nil || entry.closing || entry.credentialID != association.credentialID {
		t.mu.Unlock()
		http.Error(w, "MCP server is unavailable", http.StatusServiceUnavailable)
		return
	}
	t.associations[token] = association
	t.activeCalls[association] = struct{}{}
	admission.association = association
	t.mu.Unlock()

	request := r.Clone(r.Context())
	request.Header = r.Header.Clone()
	removeHeaderCaseInsensitive(request.Header, associationHeader)
	request.Header.Set(associationHeader, token)
	t.handler.ServeHTTP(w, request)
	t.sealAssociation(association)
}

func (t *Transport) server(r *http.Request) *sdk.Server {
	admission, ok := r.Context().Value(admissionKey{}).(*sessionAdmission)
	if !ok {
		return nil
	}
	if admission.server != nil {
		return admission.server
	}
	if id := r.Header.Get("Mcp-Session-Id"); id != "" {
		t.mu.Lock()
		entry := t.sessions[id]
		var server *sdk.Server
		if entry != nil && !entry.closing {
			server = entry.server
		}
		t.mu.Unlock()
		return server
	}
	id, err := t.newSession(admission.credential.ID)
	if err != nil {
		return nil
	}
	admission.id = id
	server := sdk.NewServer(&sdk.Implementation{Name: "videocutlist", Version: "1"}, &sdk.ServerOptions{
		PageSize: maxToolPage, GetSessionID: func() string { return id },
		SupportedProtocolVersions: []string{ProtocolVersion},
		Capabilities:              &sdk.ServerCapabilities{Tools: &sdk.ToolCapabilities{}},
	})
	for _, tool := range t.config.Tools {
		if admission.credential.HasPermission(tool.Permission) {
			server.AddTool(&sdk.Tool{Name: tool.Name, Description: tool.Description, InputSchema: tool.InputSchema}, t.callAssociatedTool)
		}
	}
	// Intercept calls before SDK tool lookup to keep unavailable and denied
	// tools indistinguishable, while preserving resource checks and safe errors.
	server.AddReceivingMiddleware(func(next sdk.MethodHandler) sdk.MethodHandler {
		return func(ctx context.Context, method string, req sdk.Request) (sdk.Result, error) {
			if method == "tools/call" {
				call, ok := req.(*sdk.CallToolRequest)
				if !ok {
					return nil, &jsonrpc.Error{Code: -32602, Message: "Invalid params"}
				}
				return t.callAssociatedTool(ctx, call)
			}
			return next(ctx, method, req)
		}
	})
	t.mu.Lock()
	entry := t.sessions[id]
	if t.shuttingDown || entry == nil || entry.closing {
		t.mu.Unlock()
		return nil
	}
	entry.server = server
	admission.server = server
	t.mu.Unlock()
	return server
}

func (t *Transport) claimAssociation(ctx context.Context, req *sdk.CallToolRequest) (*requestAssociation, context.Context, func() bool, bool) {
	if req == nil || req.Extra == nil || req.Extra.Header == nil {
		return nil, nil, func() bool { return false }, false
	}
	tokens := headerValuesCaseInsensitive(req.Extra.Header, associationHeader)
	sessions := req.Extra.Header.Values("Mcp-Session-Id")
	if len(tokens) != 1 || len(sessions) != 1 {
		return nil, nil, func() bool { return false }, false
	}
	t.mu.Lock()
	association := t.associations[tokens[0]]
	if association == nil || association.sealed || association.claimed || association.sessionID != sessions[0] {
		t.mu.Unlock()
		return nil, nil, func() bool { return false }, false
	}
	entry := t.sessions[association.sessionID]
	if t.shuttingDown || entry == nil || entry.closing || entry.credentialID != association.credentialID {
		t.mu.Unlock()
		return nil, nil, func() bool { return false }, false
	}
	appContext, cancel := context.WithCancel(ctx)
	association.claimed = true
	association.appCancel = cancel
	t.mu.Unlock()
	stop := context.AfterFunc(association.requestCtx, cancel)
	if association.requestCtx.Err() != nil {
		cancel()
	}
	return association, appContext, stop, true
}

func (t *Transport) finishAssociationCall(association *requestAssociation) {
	t.mu.Lock()
	if association.claimed {
		close(association.appDone)
	}
	t.mu.Unlock()
}

func (t *Transport) sealAssociation(association *requestAssociation) {
	t.mu.Lock()
	association.sealed = true
	if t.associations[association.token] == association {
		delete(t.associations, association.token)
	}
	claimed := association.claimed
	t.mu.Unlock()
	if claimed {
		<-association.appDone
	}
}

func (t *Transport) finishAssociationDispatch(association *requestAssociation) {
	t.mu.Lock()
	delete(t.activeCalls, association)
	close(association.dispatchDone)
	t.mu.Unlock()
}

func (t *Transport) callAssociatedTool(ctx context.Context, req *sdk.CallToolRequest) (*sdk.CallToolResult, error) {
	association, appContext, stop, ok := t.claimAssociation(ctx, req)
	if !ok {
		return nil, &jsonrpc.Error{Code: -32602, Message: "Unknown or unauthorized tool"}
	}
	defer func() {
		stop()
		association.appCancel()
		t.finishAssociationCall(association)
	}()
	if appContext.Err() != nil {
		return nil, appContext.Err()
	}
	copyRequest := *req
	if req.Extra != nil {
		extra := *req.Extra
		extra.Header = req.Extra.Header.Clone()
		removeHeaderCaseInsensitive(extra.Header, associationHeader)
		copyRequest.Extra = &extra
	}
	return t.sdkCall(appContext, &copyRequest, association)
}

func (t *Transport) sdkCall(ctx context.Context, req *sdk.CallToolRequest, association *requestAssociation) (*sdk.CallToolResult, error) {
	if req.Extra == nil {
		return nil, &jsonrpc.Error{Code: -32603, Message: "Internal error"}
	}
	token, ok := bearerToken(req.Extra.Header.Values("Authorization"))
	if !ok {
		return nil, &jsonrpc.Error{Code: -32602, Message: "Unknown or unauthorized tool"}
	}
	credential, err := t.config.Credentials.Authenticate(ctx, token)
	if err != nil || association == nil || credential.ID != association.credentialID {
		return nil, &jsonrpc.Error{Code: -32602, Message: "Unknown or unauthorized tool"}
	}
	r := (&http.Request{Header: req.Extra.Header}).WithContext(ctx)
	if r.Header.Get("Mcp-Session-Id") != association.sessionID || !t.validSession(r, credential.ID, false) {
		return nil, &jsonrpc.Error{Code: -32602, Message: "Unknown or unauthorized tool"}
	}
	raw, err := json.Marshal(req.Params)
	if err != nil {
		return nil, &jsonrpc.Error{Code: -32602, Message: "Invalid params"}
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	result, rpcErr := t.callTool(r, raw, credential)
	if rpcErr != nil {
		return nil, rpcErr
	}
	out := &sdk.CallToolResult{Content: make([]sdk.Content, 0, len(result.Content)), StructuredContent: result.StructuredContent, IsError: result.IsError}
	for _, content := range result.Content {
		out.Content = append(out.Content, &sdk.TextContent{Text: content.Text})
	}
	return out, nil
}

func (t *Transport) callTool(r *http.Request, raw json.RawMessage, credential Credential) (ToolResult, *jsonrpc.Error) {
	var params struct {
		Name      string          `json:"name"`
		Arguments json.RawMessage `json:"arguments"`
	}
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&params) != nil || params.Name == "" || len(params.Name) > 128 || decoder.Decode(new(any)) != io.EOF {
		return ToolResult{}, &jsonrpc.Error{Code: -32602, Message: "Invalid params"}
	}
	for _, tool := range t.config.Tools {
		if tool.Name != params.Name {
			continue
		}
		if !credential.HasPermission(tool.Permission) {
			return ToolResult{}, &jsonrpc.Error{Code: -32602, Message: "Unknown or unauthorized tool"}
		}
		if tool.Resource == nil {
			return ToolResult{}, &jsonrpc.Error{Code: -32603, Message: "Internal error"}
		}
		credentialID := credential.ID
		context := Context{Request: r, Credential: credential}
		resource, err := tool.Resource(context, params.Arguments)
		if err != nil {
			t.recordAudit(r, credentialID, tool.Name, toolErrorCode(err), resource, "")
			return toolError(err), nil
		}
		credential, err = t.config.Credentials.AuthorizeCredential(r.Context(), credentialID, tool.Permission, resource)
		if err != nil {
			t.recordAudit(r, credentialID, tool.Name, toolErrorCode(err), resource, "")
			if errors.Is(err, ErrPermissionDenied) {
				return ToolResult{}, &jsonrpc.Error{Code: -32602, Message: "Unknown or unauthorized tool"}
			}
			return toolError(err), nil
		}
		if tool.Call == nil {
			return ToolResult{}, &jsonrpc.Error{Code: -32603, Message: "Internal error"}
		}
		context.Credential = credential
		result, err := tool.Call(context, params.Arguments)
		if err != nil {
			t.recordAudit(r, credentialID, tool.Name, toolErrorCode(err), resource, "")
			return toolError(err), nil
		}
		// The tool call may have committed a mutation even when its response cannot be encoded or exceeds the result limit.
		t.recordAudit(r, credentialID, tool.Name, "success", resource, resultJobID(result))
		encoded, err := json.Marshal(result)
		if err != nil || len(encoded) > maxResultBytes {
			return ToolResult{}, &jsonrpc.Error{Code: -32603, Message: "Tool result exceeded the server limit"}
		}
		return result, nil
	}
	return ToolResult{}, &jsonrpc.Error{Code: -32602, Message: "Unknown or unauthorized tool"}
}

func (t *Transport) recordAudit(r *http.Request, credentialID, operation, outcome string, resource Resource, jobID string) {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), auditWriteTimeout)
	defer cancel()
	if _, err := t.config.Credentials.RecordAudit(ctx, credentialID, AuditInput{Operation: operation, Outcome: outcome, ResourceIDs: auditResourceIDs(resource), JobID: jobID}); err != nil && t.config.Logger != nil {
		t.config.Logger.Print(`{"error_category":"mcp_audit_write"}`)
	}
}
func auditResourceIDs(resource Resource) []string {
	ids := make([]string, 0, auditResourceLimit)
	seen := make(map[string]bool, auditResourceLimit)
	add := func(value string) {
		if len(ids) < auditResourceLimit && value != "" && validSafeIdentifier(value) && !seen[value] {
			seen[value] = true
			ids = append(ids, value)
		}
	}
	add(resource.ProjectID)
	add(resource.MediaID)
	for _, item := range resource.ProjectMedia {
		if len(ids) == auditResourceLimit {
			break
		}
		add(item.ID)
		add(item.RootID)
	}
	return ids
}
func resultJobID(result ToolResult) string {
	for _, key := range []string{"jobId", "id", "batchId"} {
		if value, ok := result.StructuredContent[key].(string); ok && validSafeIdentifier(value) {
			return value
		}
	}
	if jobs, ok := result.StructuredContent["jobs"].([]any); ok && len(jobs) > 0 {
		if job, ok := jobs[0].(map[string]any); ok {
			if value, ok := job["id"].(string); ok && validSafeIdentifier(value) {
				return value
			}
		}
	}
	return ""
}
func toolErrorCode(err error) string {
	switch {
	case errors.Is(err, ErrInvalidInput):
		return "invalid_input"
	case errors.Is(err, ErrResourceDenied), errors.Is(err, ErrPermissionDenied), errors.Is(err, ErrCredentialUnauthorized), errors.Is(err, ErrProposalNotFound):
		return "access_denied"
	case errors.Is(err, ErrProposalStale), errors.Is(err, jobs.ErrSourceChanged):
		return "stale_or_changed_source"
	case errors.Is(err, ErrProposalBlocked):
		return "incompatibility"
	case errors.Is(err, ErrProposalApprovalNeeded):
		return "missing_approval"
	case errors.Is(err, ErrProposalExpired):
		return "expiry"
	case errors.Is(err, jobqueue.ErrQueueFull):
		return "capacity"
	default:
		return "internal_error"
	}
}
func toolError(err error) ToolResult {
	code := toolErrorCode(err)
	message := map[string]string{"invalid_input": "Tool input is invalid.", "access_denied": "Resource is unavailable or unauthorized.", "stale_or_changed_source": "Source or revision changed; request a new proposal.", "incompatibility": "Export is incompatible with the requested options.", "missing_approval": "App approval is required before starting this export.", "expiry": "The proposal expired; request a new proposal.", "capacity": "Server capacity is exhausted; retry later.", "internal_error": "Tool failed."}[code]
	return ToolResult{Content: []ToolContent{{Type: "text", Text: "Tool failed."}}, StructuredContent: map[string]any{"error": map[string]any{"code": code, "message": message}}, IsError: true}
}
func (t *Transport) requestInfo(r *http.Request) RequestInfo {
	if t.config.RequestInfo != nil {
		return t.config.RequestInfo(r)
	}
	host, _, _ := net.SplitHostPort(r.RemoteAddr)
	proto := "http"
	if r.TLS != nil {
		proto = "https"
	}
	return RequestInfo{ClientIP: net.ParseIP(host), Host: r.Host, Proto: proto}
}
func loopbackAuthority(authority string) bool {
	host, _, err := net.SplitHostPort(authority)
	if err != nil {
		host = strings.Trim(authority, "[]")
	}
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func (t *Transport) validTransport(r *http.Request, info RequestInfo) bool {
	if address, ok := r.Context().Value(http.LocalAddrContextKey).(net.Addr); ok && address != nil && loopbackAuthority(address.String()) && !loopbackAuthority(r.Host) && !strings.EqualFold(r.Host, t.publicAuthority) {
		return false
	}
	if info.ClientIP == nil || !info.ClientIP.IsLoopback() && info.Proto != "https" {
		return false
	}
	origins := r.Header.Values("Origin")
	if len(origins) == 0 {
		return true
	}
	if len(origins) != 1 {
		return false
	}
	origin := origins[0]
	parsed, err := url.Parse(origin)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" || parsed.User != nil || parsed.Path != "" || parsed.RawQuery != "" || parsed.ForceQuery || parsed.Fragment != "" || parsed.Opaque != "" {
		return false
	}
	if _, ok := t.allowed[origin]; ok {
		return true
	}
	return origin == info.Proto+"://"+info.Host
}
func (t *Transport) newSession(credentialID string) (string, error) {
	bytes := make([]byte, 24)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	now := t.config.Now().UTC()
	t.pruneSessions(now)
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.shuttingDown {
		return "", errors.New("mcp transport is shutting down")
	}
	if t.sessionCountLocked(credentialID) >= t.config.MaxSessions {
		return "", errors.New("session capacity reached")
	}
	id := base64.RawURLEncoding.EncodeToString(bytes)
	t.sessions[id] = &session{credentialID: credentialID, lastUsed: now, initializing: true}
	return id, nil
}
func (t *Transport) validSession(r *http.Request, credentialID string, trackRequest bool) bool {
	values := r.Header.Values("Mcp-Session-Id")
	if len(values) != 1 || values[0] == "" || len(values[0]) > 128 {
		return false
	}
	now := t.config.Now().UTC()
	t.pruneSessions(now)
	t.mu.Lock()
	defer t.mu.Unlock()
	entry := t.sessions[values[0]]
	if entry == nil || entry.credentialID != credentialID || !entry.initialized || entry.closing {
		return false
	}
	entry.lastUsed = now
	if trackRequest {
		entry.inFlight++
	}
	return true
}
func (t *Transport) releaseSessionRequest(id string) {
	now := t.config.Now().UTC()
	t.mu.Lock()
	if entry := t.sessions[id]; entry != nil {
		entry.inFlight--
		if entry.inFlight < 0 {
			panic("negative MCP session request count")
		}
		entry.lastUsed = now
	}
	t.mu.Unlock()
	t.pruneSessions(now)
}
func (t *Transport) hasSessionCapacity(credentialID string) bool {
	t.pruneSessions(t.config.Now().UTC())
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.sessionCountLocked(credentialID) < t.config.MaxSessions
}
func (t *Transport) sessionCountLocked(credentialID string) int {
	count := 0
	for _, entry := range t.sessions {
		if entry.credentialID == credentialID {
			count++
		}
	}
	return count
}
func (t *Transport) finishInitialization(id string) {
	t.mu.Lock()
	entry := t.sessions[id]
	if entry == nil {
		t.mu.Unlock()
		return
	}
	entry.initializing = false
	entry.initialized = serverHasInitializedSession(entry.server, id)
	if entry.initialized {
		t.mu.Unlock()
		return
	}
	entry.closing = true
	t.mu.Unlock()
	closeServerSession(entry.server, id)
	t.mu.Lock()
	if t.sessions[id] == entry {
		delete(t.sessions, id)
	}
	t.mu.Unlock()
}
func (t *Transport) removeSession(id string) {
	t.mu.Lock()
	entry := t.sessions[id]
	if entry != nil {
		entry.closing = true
	}
	t.mu.Unlock()
	if entry == nil {
		return
	}
	closeServerSession(entry.server, id)
	t.mu.Lock()
	if t.sessions[id] == entry {
		delete(t.sessions, id)
	}
	t.mu.Unlock()
}
func (t *Transport) pruneSessions(now time.Time) {
	type staleSession struct {
		id    string
		entry *session
	}
	var stale []staleSession
	t.mu.Lock()
	for id, entry := range t.sessions {
		if entry.initializing || entry.inFlight != 0 || entry.closing {
			continue
		}
		expired := now.Sub(entry.lastUsed) >= t.config.SessionTTL
		missing := entry.initialized && !serverHasInitializedSession(entry.server, id)
		if expired || missing {
			entry.closing = true
			stale = append(stale, staleSession{id: id, entry: entry})
		}
	}
	t.mu.Unlock()
	for _, stale := range stale {
		closeServerSession(stale.entry.server, stale.id)
		t.mu.Lock()
		if t.sessions[stale.id] == stale.entry {
			delete(t.sessions, stale.id)
		}
		t.mu.Unlock()
	}
}
func serverHasInitializedSession(server *sdk.Server, id string) bool {
	if server == nil {
		return false
	}
	for session := range server.Sessions() {
		if session.ID() == id && session.InitializeParams() != nil {
			return true
		}
	}
	return false
}
func closeServerSession(server *sdk.Server, id string) {
	if server == nil {
		return
	}
	for session := range server.Sessions() {
		if session.ID() == id {
			_ = session.Close()
			return
		}
	}
}
func (t *Transport) acquireWork(credentialID string) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.shuttingDown || t.workRequests[credentialID] >= t.config.MaxConcurrentRequests {
		return false
	}
	t.workRequests[credentialID]++
	return true
}
func (t *Transport) releaseWork(credentialID string) {
	t.mu.Lock()
	t.workRequests[credentialID]--
	if t.workRequests[credentialID] <= 0 {
		delete(t.workRequests, credentialID)
	}
	t.mu.Unlock()
	t.notifyWorkChanged()
}
func (t *Transport) acquireControl(credentialID string) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.shuttingDown || t.controlRequests[credentialID] >= maxControlConcurrentRequests {
		return false
	}
	t.controlRequests[credentialID]++
	return true
}
func (t *Transport) releaseControl(credentialID string) {
	t.mu.Lock()
	t.controlRequests[credentialID]--
	if t.controlRequests[credentialID] <= 0 {
		delete(t.controlRequests, credentialID)
	}
	t.mu.Unlock()
	t.notifyWorkChanged()
}
func (t *Transport) allowRequest(credentialID string) bool {
	now := t.config.Now().UTC()
	t.mu.Lock()
	defer t.mu.Unlock()
	for id, existing := range t.rates {
		if now.Sub(existing.window) >= time.Minute {
			delete(t.rates, id)
		}
	}
	entry := t.rates[credentialID]
	if entry.window.IsZero() || now.Sub(entry.window) >= time.Minute {
		entry = rate{window: now}
	}
	if entry.count >= t.config.RequestsPerMinute {
		return false
	}
	entry.count++
	t.rates[credentialID] = entry
	return true
}
func bearerToken(values []string) (string, bool) {
	if len(values) != 1 || !strings.HasPrefix(values[0], "Bearer ") {
		return "", false
	}
	token := strings.TrimPrefix(values[0], "Bearer ")
	return token, token != "" && !strings.ContainsAny(token, " \t\r\n")
}
func writeBusy(w http.ResponseWriter) {
	w.Header().Set("Retry-After", "1")
	http.Error(w, "server busy", http.StatusTooManyRequests)
}

func unauthorized(w http.ResponseWriter) {
	w.Header().Set("WWW-Authenticate", `Bearer realm="mcp"`)
	http.Error(w, "unauthorized", http.StatusUnauthorized)
}
