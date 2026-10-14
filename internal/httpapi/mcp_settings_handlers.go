package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"maps"
	"net/http"
	"slices"
	"strconv"
	"time"

	"videocutlist/internal/httpapi/transport"
	"videocutlist/internal/mcp"
)

const maxMCPCredentialBodyBytes = 64 << 10

func domainMCPCredentialInput(input transport.MCPCredentialCreate) mcp.CredentialInput {
	var permissions []mcp.Permission
	if input.Permissions != nil {
		permissions = make([]mcp.Permission, len(input.Permissions))
		for index, permission := range input.Permissions {
			permissions[index] = mcp.Permission(permission)
		}
	}
	mediaScope := mcp.MediaScope{Kind: mcp.MediaScopeKind(input.MediaScope.Kind)}
	if input.MediaScope.RootIds != nil {
		mediaScope.RootIDs = *input.MediaScope.RootIds
	}
	if input.MediaScope.MediaIds != nil {
		mediaScope.MediaIDs = *input.MediaScope.MediaIds
	}
	projectScope := mcp.ProjectScope{Kind: mcp.ProjectScopeKind(input.ProjectScope.Kind)}
	if input.ProjectScope.ProjectIds != nil {
		projectScope.ProjectIDs = *input.ProjectScope.ProjectIds
	}
	credential := mcp.CredentialInput{
		Name: input.Name, Permissions: permissions, MediaScope: mediaScope,
		ProjectScope: projectScope, ExpiresAt: input.ExpiresAt,
	}
	if input.AllowNonExpiring != nil {
		credential.AllowNonExpiring = *input.AllowNonExpiring
	}
	if input.UnattendedExports != nil {
		credential.UnattendedExports = *input.UnattendedExports
	}
	return credential
}

func (s *Server) getMCPSettings(w http.ResponseWriter, r *http.Request, id string) {
	if s.config.Settings == nil || s.config.MCPCredentials == nil {
		httpx.Error(w, http.StatusNotFound, "mcp_settings_unavailable", "MCP settings are not available.", id)
		return
	}
	if !queryKeys(r, "cursor", "limit", "proposalCursor", "proposalLimit") {
		httpx.Error(w, http.StatusBadRequest, "invalid_query", "Query parameters are invalid.", id)
		return
	}
	query := r.URL.Query()
	limit := 0
	if raw := query.Get("limit"); raw != "" {
		var err error
		limit, err = strconv.Atoi(raw)
		if err != nil || limit < 1 || limit > 100 {
			httpx.Error(w, http.StatusBadRequest, "invalid_query", "Query parameters are invalid.", id)
			return
		}
	}
	proposalLimit := 0
	if raw := query.Get("proposalLimit"); raw != "" {
		var err error
		proposalLimit, err = strconv.Atoi(raw)
		if err != nil || proposalLimit < 1 || proposalLimit > 100 {
			httpx.Error(w, http.StatusBadRequest, "invalid_query", "Query parameters are invalid.", id)
			return
		}
	}
	settings, err := s.config.Settings.Get(r.Context())
	if err != nil {
		internalServerError(w, http.StatusInternalServerError, "mcp_settings_unavailable", "MCP settings are temporarily unavailable.", id, err)
		return
	}
	credentials, next, err := s.config.MCPCredentials.List(r.Context(), query.Get("cursor"), limit)
	if err != nil {
		if errors.Is(err, mcp.ErrCredentialNotFound) {
			httpx.Error(w, http.StatusBadRequest, "invalid_query", "Query parameters are invalid.", id)
		} else {
			internalServerError(w, http.StatusInternalServerError, "mcp_settings_unavailable", "MCP settings are temporarily unavailable.", id, err)
		}
		return
	}
	proposals := []mcp.ExportProposal{}
	var proposalNext *string
	if s.config.ExportProposals != nil {
		proposals, proposalNext, err = s.config.ExportProposals.ListPending(r.Context(), query.Get("proposalCursor"), proposalLimit)
		if err != nil {
			if errors.Is(err, mcp.ErrInvalidProposalCursor) {
				httpx.Error(w, http.StatusBadRequest, "invalid_query", "Query parameters are invalid.", id)
			} else {
				internalServerError(w, http.StatusInternalServerError, "export_proposals_unavailable", "Export proposals are temporarily unavailable.", id, err)
			}
			return
		}
	}
	views := make([]transport.MCPCredential, 0, len(credentials))
	now := time.Now().UTC()
	for _, credential := range credentials {
		status := "active"
		if credential.RevokedAt != nil {
			status = "revoked"
		} else if !credential.ActiveAt(now) {
			status = "expired"
		}
		views = append(views, mcpCredentialToTransport(credential, status))
	}
	mappedProposals, err := mcpExportProposalsToTransport(proposals)
	if err != nil {
		internalError(w, id, err)
		return
	}
	rootIDs := slices.Sorted(maps.Keys(settings.Settings.MediaRoots))
	roots := make([]struct {
		Id    string `json:"id"`
		Label string `json:"label"`
	}, 0, len(rootIDs))
	for _, rootID := range rootIDs {
		roots = append(roots, struct {
			Id    string `json:"id"`
			Label string `json:"label"`
		}{Id: rootID, Label: rootID})
	}
	response := transport.MCPSettingsResponse{
		Enabled: settings.Settings.MCPEnabled, Endpoint: "/mcp", Authentication: "Bearer token",
		RemoteAccessGuidance: "Keep the server loopback-only unless remote access is deliberately configured. Use HTTPS for every remote connection.",
		ClientCompatibility:  "Tested with MCP Inspector using Streamable HTTP bearer tokens (protocol 2025-06-18). OAuth-only clients are not supported.",
		Permissions:          mcpPermissionsToTransport(mcp.KnownPermissions()), Roots: roots, Credentials: views, Proposals: mappedProposals,
	}
	if next != nil {
		response.NextCursor = next
	}
	if proposalNext != nil {
		response.ProposalNextCursor = proposalNext
	}
	httpx.WriteJSON(w, http.StatusOK, response)
}

func (s *Server) createMCPCredential(w http.ResponseWriter, r *http.Request, id string) {
	if s.config.Settings == nil || s.config.MCPCredentials == nil {
		httpx.Error(w, http.StatusNotFound, "mcp_settings_unavailable", "MCP settings are not available.", id)
		return
	}
	var requestBody transport.MCPCredentialCreate
	if err := decodeMCPRequest(r, &requestBody); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_mcp_credential", "Credential settings are invalid.", id)
		return
	}
	input := domainMCPCredentialInput(requestBody)
	if input.MediaScope.Kind == mcp.MediaScopeRoots {
		settings, err := s.config.Settings.Get(r.Context())
		if err != nil {
			internalServerError(w, http.StatusInternalServerError, "mcp_settings_unavailable", "Credential settings are temporarily unavailable.", id, err)
			return
		}
		for _, rootID := range input.MediaScope.RootIDs {
			if _, ok := settings.Settings.MediaRoots[rootID]; !ok {
				httpx.Error(w, http.StatusBadRequest, "invalid_mcp_credential", "Credential settings are invalid.", id)
				return
			}
		}
	}
	created, err := s.config.MCPCredentials.Create(r.Context(), input)
	if err != nil {
		if errors.Is(err, mcp.ErrCredentialInvalid) || errors.Is(err, mcp.ErrCredentialExpired) || errors.Is(err, mcp.ErrNonExpiringCredentialNeedsAck) {
			httpx.Error(w, http.StatusBadRequest, "invalid_mcp_credential", "Credential settings are invalid.", id)
			return
		}
		internalServerError(w, http.StatusInternalServerError, "mcp_settings_unavailable", "Credential could not be created.", id, err)
		return
	}
	httpx.WriteJSON(w, http.StatusCreated, mcpCreatedCredentialToTransport(created))
}

func (s *Server) revokeMCPCredential(w http.ResponseWriter, r *http.Request, credentialID, id string) {
	if s.config.MCPCredentials == nil {
		httpx.Error(w, http.StatusNotFound, "mcp_settings_unavailable", "MCP settings are not available.", id)
		return
	}
	credential, err := s.config.MCPCredentials.Revoke(r.Context(), credentialID)
	if errors.Is(err, mcp.ErrCredentialNotFound) {
		notFound(w, id)
		return
	}
	if err != nil {
		internalServerError(w, http.StatusInternalServerError, "mcp_settings_unavailable", "Credential could not be revoked.", id, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, mcpCredentialToTransport(credential, "revoked"))
}

func decodeMCPRequest(r *http.Request, destination any) error {
	body, err := io.ReadAll(io.LimitReader(r.Body, maxMCPCredentialBodyBytes+1))
	if err != nil || len(body) > maxMCPCredentialBodyBytes {
		return errors.New("invalid body")
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return errors.New("trailing JSON data")
	}
	return nil
}
