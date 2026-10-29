package mcp

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"github.com/modelcontextprotocol/go-sdk/jsonrpc"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
	"io"
	"net/http"
	"strings"
	jobs "videocutlist/internal/jobs"
	jobqueue "videocutlist/internal/jobs/model"
)

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
