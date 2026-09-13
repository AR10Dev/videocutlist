package mcp

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	// ProtocolVersion is the stable MCP revision implemented by this transport.
	ProtocolVersion = "2025-06-18"
	maxRequestBytes = 1 << 20
	maxResultBytes  = 1 << 20
	maxToolPage     = 100
)

type RequestInfo struct {
	ClientIP net.IP
	Host     string
	Proto    string
}

type Tool struct {
	Name        string
	Description string
	InputSchema map[string]any
	Permission  Permission
	Resource    func(context Context, arguments json.RawMessage) (Resource, error)
	Call        func(context Context, arguments json.RawMessage) (ToolResult, error)
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
	Enabled               bool
	Credentials           *CredentialStore
	Tools                 []Tool
	AllowedOrigins        []string
	RequestInfo           func(*http.Request) RequestInfo
	MaxConcurrentRequests int
	RequestsPerMinute     int
	MaxSessions           int
	SessionTTL            time.Duration
	Now                   func() time.Time
}

type transport struct {
	config   TransportConfig
	allowed  map[string]struct{}
	slots    chan struct{}
	mu       sync.Mutex
	sessions map[string]session
	rates    map[string]rate
}

type session struct {
	credentialID string
	lastUsed     time.Time
}

type rate struct {
	window time.Time
	count  int
}

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
}

type rpcResponse struct {
	JSONRPC string    `json:"jsonrpc"`
	ID      any       `json:"id"`
	Result  any       `json:"result,omitempty"`
	Error   *rpcError `json:"error,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func NewTransport(config TransportConfig) (http.Handler, error) {
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
	allowed := make(map[string]struct{}, len(config.AllowedOrigins))
	for _, origin := range config.AllowedOrigins {
		allowed[origin] = struct{}{}
	}
	return &transport{config: config, allowed: allowed, slots: make(chan struct{}, config.MaxConcurrentRequests), sessions: make(map[string]session), rates: make(map[string]rate)}, nil
}

func (t *transport) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !t.config.Enabled {
		http.NotFound(w, r)
		return
	}
	if r.Method != http.MethodPost && r.Method != http.MethodDelete {
		w.Header().Set("Allow", "POST, DELETE")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	info := t.requestInfo(r)
	if !t.validTransport(r, info) {
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
	if r.Method == http.MethodDelete {
		t.deleteSession(w, r, credential)
		return
	}
	if !accepts(r.Header.Get("Accept"), "application/json") || !accepts(r.Header.Get("Accept"), "text/event-stream") {
		http.Error(w, "Accept must include application/json and text/event-stream", http.StatusNotAcceptable)
		return
	}
	if mediaType(r.Header.Get("Content-Type")) != "application/json" {
		http.Error(w, "Content-Type must be application/json", http.StatusUnsupportedMediaType)
		return
	}
	select {
	case t.slots <- struct{}{}:
		defer func() { <-t.slots }()
	default:
		w.Header().Set("Retry-After", "1")
		http.Error(w, "server busy", http.StatusTooManyRequests)
		return
	}
	t.post(w, r, credential)
}

func (t *transport) post(w http.ResponseWriter, r *http.Request, credential Credential) {
	body := http.MaxBytesReader(w, r.Body, maxRequestBytes)
	decoder := json.NewDecoder(body)
	decoder.DisallowUnknownFields()
	var request rpcRequest
	if err := decoder.Decode(&request); err != nil {
		if _, ok := errors.AsType[*http.MaxBytesError](err); ok {
			writeRPC(w, http.StatusRequestEntityTooLarge, rpcResponse{JSONRPC: "2.0", ID: nil, Error: &rpcError{Code: -32600, Message: "Request too large"}})
		} else {
			writeRPC(w, http.StatusBadRequest, rpcResponse{JSONRPC: "2.0", ID: nil, Error: &rpcError{Code: -32700, Message: "Parse error"}})
		}
		return
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF || request.JSONRPC != "2.0" || request.Method == "" || len(request.ID) > 128 || !validRPCID(request.ID) {
		writeRPC(w, http.StatusBadRequest, rpcResponse{JSONRPC: "2.0", ID: nil, Error: &rpcError{Code: -32600, Message: "Invalid Request"}})
		return
	}
	id := decodeID(request.ID)
	if request.Method == "initialize" {
		t.initialize(w, request, id, credential)
		return
	}
	if !t.validSession(r, credential.ID) {
		writeRPC(w, http.StatusNotFound, rpcResponse{JSONRPC: "2.0", ID: id, Error: &rpcError{Code: -32001, Message: "Session not found"}})
		return
	}
	if r.Header.Get("MCP-Protocol-Version") != ProtocolVersion {
		writeRPC(w, http.StatusBadRequest, rpcResponse{JSONRPC: "2.0", ID: id, Error: &rpcError{Code: -32600, Message: "Unsupported MCP protocol version"}})
		return
	}

	response := rpcResponse{JSONRPC: "2.0", ID: id}
	switch request.Method {
	case "notifications/initialized":
		w.WriteHeader(http.StatusAccepted)
		return
	case "ping":
		response.Result = map[string]any{}
	case "tools/list":
		result, rpcErr := t.listTools(request.Params, credential)
		response.Result, response.Error = result, rpcErr
	case "tools/call":
		result, rpcErr := t.callTool(r, request.Params, credential)
		response.Result, response.Error = result, rpcErr
	default:
		response.Error = &rpcError{Code: -32601, Message: "Method not found"}
	}
	if len(request.ID) == 0 || string(request.ID) == "null" {
		w.WriteHeader(http.StatusAccepted)
		return
	}
	writeRPC(w, http.StatusOK, response)
}

func (t *transport) initialize(w http.ResponseWriter, request rpcRequest, id any, credential Credential) {
	var params struct {
		ProtocolVersion string          `json:"protocolVersion"`
		Capabilities    json.RawMessage `json:"capabilities"`
		ClientInfo      struct {
			Name    string `json:"name"`
			Version string `json:"version"`
		} `json:"clientInfo"`
	}
	if len(request.ID) == 0 || string(request.ID) == "null" || json.Unmarshal(request.Params, &params) != nil || params.ProtocolVersion == "" || len(params.Capabilities) == 0 || params.ClientInfo.Name == "" || params.ClientInfo.Version == "" {
		writeRPC(w, http.StatusOK, rpcResponse{JSONRPC: "2.0", ID: id, Error: &rpcError{Code: -32602, Message: "Invalid params"}})
		return
	}
	sessionID, err := t.newSession(credential.ID)
	if err != nil {
		writeRPC(w, http.StatusServiceUnavailable, rpcResponse{JSONRPC: "2.0", ID: id, Error: &rpcError{Code: -32000, Message: "Session capacity reached"}})
		return
	}
	w.Header().Set("Mcp-Session-Id", sessionID)
	writeRPC(w, http.StatusOK, rpcResponse{JSONRPC: "2.0", ID: id, Result: map[string]any{
		"protocolVersion": ProtocolVersion,
		"capabilities":    map[string]any{"tools": map[string]any{"listChanged": false}},
		"serverInfo":      map[string]string{"name": "videocutlist", "version": "1"},
	}})
}

func (t *transport) listTools(raw json.RawMessage, credential Credential) (any, *rpcError) {
	var params struct {
		Cursor string `json:"cursor"`
	}
	if len(raw) != 0 && string(raw) != "null" && json.Unmarshal(raw, &params) != nil {
		return nil, &rpcError{Code: -32602, Message: "Invalid params"}
	}
	start := 0
	if params.Cursor != "" {
		value, err := strconv.Atoi(params.Cursor)
		if err != nil || value < 0 {
			return nil, &rpcError{Code: -32602, Message: "Invalid cursor"}
		}
		start = value
	}
	visible := make([]map[string]any, 0, len(t.config.Tools))
	for _, tool := range t.config.Tools {
		if credential.HasPermission(tool.Permission) {
			visible = append(visible, map[string]any{"name": tool.Name, "description": tool.Description, "inputSchema": tool.InputSchema})
		}
	}
	if start > len(visible) {
		return nil, &rpcError{Code: -32602, Message: "Invalid cursor"}
	}
	end := min(start+maxToolPage, len(visible))
	result := map[string]any{"tools": visible[start:end]}
	if end < len(visible) {
		result["nextCursor"] = strconv.Itoa(end)
	}
	return result, nil
}

func (t *transport) callTool(r *http.Request, raw json.RawMessage, credential Credential) (any, *rpcError) {
	var params struct {
		Name      string          `json:"name"`
		Arguments json.RawMessage `json:"arguments"`
	}
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&params) != nil || params.Name == "" || len(params.Name) > 128 || decoder.Decode(new(any)) != io.EOF {
		return nil, &rpcError{Code: -32602, Message: "Invalid params"}
	}
	for _, tool := range t.config.Tools {
		if tool.Name != params.Name {
			continue
		}
		if tool.Resource == nil {
			return nil, &rpcError{Code: -32603, Message: "Internal error"}
		}
		context := Context{Request: r, Credential: credential}
		resource, err := tool.Resource(context, params.Arguments)
		if err != nil {
			return ToolResult{Content: []ToolContent{{Type: "text", Text: "Tool failed."}}, IsError: true}, nil
		}
		credential, err = t.config.Credentials.AuthorizeCredential(r.Context(), credential.ID, tool.Permission, resource)
		if err != nil {
			if errors.Is(err, ErrPermissionDenied) {
				return nil, &rpcError{Code: -32602, Message: "Unknown or unauthorized tool"}
			}
			return ToolResult{Content: []ToolContent{{Type: "text", Text: "Tool failed."}}, IsError: true}, nil
		}
		if tool.Call == nil {
			return nil, &rpcError{Code: -32603, Message: "Internal error"}
		}
		context.Credential = credential
		result, err := tool.Call(context, params.Arguments)
		if err != nil {
			return ToolResult{Content: []ToolContent{{Type: "text", Text: "Tool failed."}}, IsError: true}, nil
		}
		encoded, err := json.Marshal(result)
		if err != nil || len(encoded) > maxResultBytes {
			return nil, &rpcError{Code: -32603, Message: "Tool result exceeded the server limit"}
		}
		return result, nil
	}
	return nil, &rpcError{Code: -32602, Message: "Unknown or unauthorized tool"}
}

func (t *transport) requestInfo(r *http.Request) RequestInfo {
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

func (t *transport) validTransport(r *http.Request, info RequestInfo) bool {
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
	if err != nil || parsed.Scheme == "" || parsed.Host == "" || parsed.User != nil || parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return false
	}
	if _, ok := t.allowed[origin]; ok {
		return true
	}
	return origin == info.Proto+"://"+info.Host
}

func (t *transport) newSession(credentialID string) (string, error) {
	bytes := make([]byte, 24)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	now := t.config.Now().UTC()
	t.mu.Lock()
	defer t.mu.Unlock()
	t.expireSessions(now)
	if len(t.sessions) >= t.config.MaxSessions {
		return "", errors.New("session capacity reached")
	}
	id := base64.RawURLEncoding.EncodeToString(bytes)
	t.sessions[id] = session{credentialID: credentialID, lastUsed: now}
	return id, nil
}

func (t *transport) validSession(r *http.Request, credentialID string) bool {
	values := r.Header.Values("Mcp-Session-Id")
	if len(values) != 1 || len(values[0]) > 128 {
		return false
	}
	now := t.config.Now().UTC()
	t.mu.Lock()
	defer t.mu.Unlock()
	t.expireSessions(now)
	entry, ok := t.sessions[values[0]]
	if !ok || entry.credentialID != credentialID {
		return false
	}
	entry.lastUsed = now
	t.sessions[values[0]] = entry
	return true
}

func (t *transport) deleteSession(w http.ResponseWriter, r *http.Request, credential Credential) {
	values := r.Header.Values("Mcp-Session-Id")
	if len(values) != 1 {
		http.NotFound(w, r)
		return
	}
	t.mu.Lock()
	entry, ok := t.sessions[values[0]]
	if ok && entry.credentialID == credential.ID {
		delete(t.sessions, values[0])
	}
	t.mu.Unlock()
	if !ok || entry.credentialID != credential.ID {
		http.NotFound(w, r)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (t *transport) expireSessions(now time.Time) {
	for id, entry := range t.sessions {
		if now.Sub(entry.lastUsed) >= t.config.SessionTTL {
			delete(t.sessions, id)
		}
	}
}

func (t *transport) allowRequest(credentialID string) bool {
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

func accepts(header, wanted string) bool {
	for part := range strings.SplitSeq(header, ",") {
		if mediaType(part) == wanted || mediaType(part) == "*/*" {
			return true
		}
	}
	return false
}

func mediaType(value string) string {
	value, _, _ = strings.Cut(strings.TrimSpace(value), ";")
	return strings.ToLower(strings.TrimSpace(value))
}

func validRPCID(raw json.RawMessage) bool {
	if len(raw) == 0 || string(raw) == "null" {
		return true
	}
	var id any
	if json.Unmarshal(raw, &id) != nil {
		return false
	}
	switch id.(type) {
	case string, float64:
		return true
	default:
		return false
	}
}

func decodeID(raw json.RawMessage) any {
	if len(raw) == 0 {
		return nil
	}
	var id any
	if json.Unmarshal(raw, &id) != nil {
		return nil
	}
	return id
}

func unauthorized(w http.ResponseWriter) {
	w.Header().Set("WWW-Authenticate", `Bearer realm="mcp"`)
	http.Error(w, "unauthorized", http.StatusUnauthorized)
}

func writeRPC(w http.ResponseWriter, status int, response rpcResponse) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(response)
}
