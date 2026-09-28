package httpapi

import (
	"errors"
	"net/http"

	"videocutlist/internal/mcp"
)

func (s *Server) getExportProposal(w http.ResponseWriter, r *http.Request, proposalID, id string) {
	if s.config.ExportProposals == nil {
		httpx.Error(w, http.StatusNotFound, "export_proposals_unavailable", "Export proposals are not available.", id)
		return
	}
	proposal, err := s.config.ExportProposals.Get(r.Context(), proposalID)
	if errors.Is(err, mcp.ErrProposalNotFound) {
		notFound(w, id)
		return
	}
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "export_proposals_unavailable", "Export proposal could not be loaded.", id)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, proposal)
}

func (s *Server) approveExportProposal(w http.ResponseWriter, r *http.Request, proposalID, id string) {
	if s.config.ExportProposals == nil {
		httpx.Error(w, http.StatusNotFound, "export_proposals_unavailable", "Export proposals are not available.", id)
		return
	}
	proposal, err := s.config.ExportProposals.Approve(r.Context(), proposalID)
	if errors.Is(err, mcp.ErrProposalNotFound) {
		notFound(w, id)
		return
	}
	if errors.Is(err, mcp.ErrProposalExpired) {
		httpx.Error(w, http.StatusConflict, "proposal_expired", "Export proposal expired; request a new proposal.", id)
		return
	}
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "export_proposals_unavailable", "Export proposal could not be approved.", id)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, proposal)
}
