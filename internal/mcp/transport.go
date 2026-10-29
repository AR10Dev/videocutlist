package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
	"log"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

const (
	ProtocolVersion                      = "2025-06-18"
	maxRequestBytes                      = 1 << 20
	maxPreAuthenticationRateLimitEntries = 1024
	maxResultBytes                       = 1 << 20
	maxToolPage                          = 100
	maxControlConcurrentRequests         = 1
	auditWriteTimeout                    = 2 * time.Second
	associationHeader                    = "X-Videocutlist-MCP-Association"
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
	config               TransportConfig
	allowed              map[string]struct{}
	publicAuthority      string
	handler              http.Handler
	mu                   sync.Mutex
	sessions             map[string]*session
	rates                map[string]rate
	preAuthRates         map[string]rate
	nextPreAuthRatePrune time.Time
	workRequests         map[string]int
	controlRequests      map[string]int
	numericIDs           map[string]map[string]string
	associations         map[string]*requestAssociation
	activeCalls          map[*requestAssociation]struct{}
	workChanged          chan struct{}
	shuttingDown         bool
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
		rates: make(map[string]rate), preAuthRates: make(map[string]rate), workRequests: make(map[string]int), controlRequests: make(map[string]int), numericIDs: make(map[string]map[string]string),
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
	info := t.requestInfo(r)
	if !t.validTransport(r, info) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	if !t.allowPreAuthenticationRequest(info.ClientIP) {
		w.Header().Set("Retry-After", "60")
		http.Error(w, "rate limit exceeded", http.StatusTooManyRequests)
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
