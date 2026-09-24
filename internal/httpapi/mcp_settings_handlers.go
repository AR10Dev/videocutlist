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

	"videocutlist/internal/mcp"
)

const maxMCPCredentialBodyBytes = 64 << 10

type mcpCredentialCreateRequest struct {
	Name              string           `json:"name"`
	Permissions       []mcp.Permission `json:"permissions"`
	MediaScope        mcp.MediaScope   `json:"mediaScope"`
	ProjectScope      mcp.ProjectScope `json:"projectScope"`
	ExpiresAt         *time.Time       `json:"expiresAt"`
	AllowNonExpiring  bool             `json:"allowNonExpiring"`
	UnattendedExports bool             `json:"unattendedExports"`
}

type mcpCredentialView struct {
	mcp.Credential
	Status string `json:"status"`
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
		httpx.Error(w, http.StatusInternalServerError, "mcp_settings_unavailable", "MCP settings are temporarily unavailable.", id)
		return
	}
	credentials, next, err := s.config.MCPCredentials.List(r.Context(), query.Get("cursor"), limit)
	if err != nil {
		if errors.Is(err, mcp.ErrCredentialNotFound) {
			httpx.Error(w, http.StatusBadRequest, "invalid_query", "Query parameters are invalid.", id)
		} else {
			httpx.Error(w, http.StatusInternalServerError, "mcp_settings_unavailable", "MCP settings are temporarily unavailable.", id)
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
				httpx.Error(w, http.StatusInternalServerError, "export_proposals_unavailable", "Export proposals are temporarily unavailable.", id)
			}
			return
		}
	}
	views := make([]mcpCredentialView, 0, len(credentials))
	now := time.Now().UTC()
	for _, credential := range credentials {
		status := "active"
		if credential.RevokedAt != nil {
			status = "revoked"
		} else if !credential.ActiveAt(now) {
			status = "expired"
		}
		views = append(views, mcpCredentialView{Credential: credential, Status: status})
	}
	rootIDs := slices.Sorted(maps.Keys(settings.Settings.MediaRoots))
	roots := make([]map[string]string, 0, len(rootIDs))
	for _, rootID := range rootIDs {
		roots = append(roots, map[string]string{"id": rootID, "label": rootID})
	}
	response := map[string]any{
		"enabled":              settings.Settings.MCPEnabled,
		"endpoint":             "/mcp",
		"authentication":       "Bearer token",
		"remoteAccessGuidance": "Keep the server loopback-only unless remote access is deliberately configured. Use HTTPS for every remote connection.",
		"clientCompatibility":  "Tested with MCP Inspector using Streamable HTTP bearer tokens (protocol 2025-06-18). OAuth-only clients are not supported.",
		"permissions":          mcp.KnownPermissions(),
		"roots":                roots,
		"credentials":          views,
		"proposals":            proposals,
	}
	if next != nil {
		response["nextCursor"] = *next
	}
	if proposalNext != nil {
		response["proposalNextCursor"] = *proposalNext
	}
	httpx.WriteJSON(w, http.StatusOK, response)
}

func (s *Server) createMCPCredential(w http.ResponseWriter, r *http.Request, id string) {
	if s.config.Settings == nil || s.config.MCPCredentials == nil {
		httpx.Error(w, http.StatusNotFound, "mcp_settings_unavailable", "MCP settings are not available.", id)
		return
	}
	var input mcpCredentialCreateRequest
	if err := decodeMCPRequest(r, &input); err != nil {
		httpx.Error(w, http.StatusUnprocessableEntity, "invalid_mcp_credential", "Credential settings are invalid.", id)
		return
	}
	if input.MediaScope.Kind == mcp.MediaScopeRoots {
		settings, err := s.config.Settings.Get(r.Context())
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "mcp_settings_unavailable", "Credential settings are temporarily unavailable.", id)
			return
		}
		for _, rootID := range input.MediaScope.RootIDs {
			if _, ok := settings.Settings.MediaRoots[rootID]; !ok {
				httpx.Error(w, http.StatusUnprocessableEntity, "invalid_mcp_credential", "Credential settings are invalid.", id)
				return
			}
		}
	}
	created, err := s.config.MCPCredentials.Create(r.Context(), mcp.CredentialInput{
		Name: input.Name, Permissions: input.Permissions, MediaScope: input.MediaScope,
		ProjectScope: input.ProjectScope, ExpiresAt: input.ExpiresAt,
		AllowNonExpiring: input.AllowNonExpiring, UnattendedExports: input.UnattendedExports,
	})
	if err != nil {
		if errors.Is(err, mcp.ErrCredentialInvalid) || errors.Is(err, mcp.ErrCredentialExpired) || errors.Is(err, mcp.ErrNonExpiringCredentialNeedsAck) {
			httpx.Error(w, http.StatusUnprocessableEntity, "invalid_mcp_credential", "Credential settings are invalid.", id)
			return
		}
		httpx.Error(w, http.StatusInternalServerError, "mcp_settings_unavailable", "Credential could not be created.", id)
		return
	}
	httpx.WriteJSON(w, http.StatusCreated, created)
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
		httpx.Error(w, http.StatusInternalServerError, "mcp_settings_unavailable", "Credential could not be revoked.", id)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, mcpCredentialView{Credential: credential, Status: "revoked"})
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
