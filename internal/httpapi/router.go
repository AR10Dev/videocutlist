package httpapi

import (
	"net/http"
	"strings"
)

type routeHandler func(*Server, http.ResponseWriter, *http.Request, string, string)
type routeDefinition struct {
	kind    routeKind
	pattern string
	handler routeHandler
}

func withoutResource(handler func(*Server, http.ResponseWriter, *http.Request, string)) routeHandler {
	return func(s *Server, w http.ResponseWriter, r *http.Request, _ string, id string) { handler(s, w, r, id) }
}

// One inventory drives ServeMux registration and contract coverage checks.
var routeDefinitions = []routeDefinition{
	{routeListMedia, "GET /api/v2/media", withoutResource((*Server).listMedia)},
	{routeBrowseMedia, "GET /api/v2/media/tree", withoutResource((*Server).browseMedia)},
	{routeMediaStatus, "GET /api/v2/media/status", withoutResource((*Server).mediaStatus)},
	{routeRefreshMedia, "POST /api/v2/media/refresh", withoutResource((*Server).refreshMedia)},
	{routeStartMediaImport, "POST /api/v2/media/import", withoutResource((*Server).startImport)},
	{routeGetMediaImport, "GET /api/v2/media/import/{jobId}", (*Server).getImport},
	{routeCancelMediaImport, "DELETE /api/v2/media/import/{jobId}", (*Server).cancelImport},
	{routeGetMedia, "GET /api/v2/media/{mediaId}", (*Server).getMedia},
	{routePreview, "GET /media/v2/media/{mediaId}/preview", (*Server).preview},
	{routeThumbnails, "GET /media/v2/media/{mediaId}/thumbnails", (*Server).thumbnails},
	{routeWaveform, "GET /media/v2/media/{mediaId}/waveform", (*Server).waveform},
	{routeListProjects, "GET /api/v2/projects", withoutResource((*Server).listProjects)},
	{routeGetProject, "GET /api/v2/projects/{projectId}", (*Server).getProject},
	{routePutProject, "PUT /api/v2/projects/{projectId}", (*Server).putProject},
	{routeCreateExport, "POST /api/v2/projects/{projectId}/exports", (*Server).createExport},
	{routePreflightExport, "POST /api/v2/projects/{projectId}/exports/preflight", (*Server).preflightExport},
	{routeImportInterchange, "POST /api/v2/projects/{projectId}/interchange/{format}", (*Server).importInterchange},
	{routeExportInterchange, "GET /media/v2/projects/{projectId}/interchange/{format}", (*Server).exportInterchange},
	{routeCreateDetection, "POST /api/v2/projects/{projectId}/detections", (*Server).createDetection},
	{routeGetJob, "GET /api/v2/jobs/{jobId}", (*Server).getJob},
	{routeStreamJob, "GET /api/v2/jobs/{jobId}/events", (*Server).streamJob},
	{routeCancelJob, "DELETE /api/v2/jobs/{jobId}", (*Server).cancelJob},
	{routeAutomation, "POST /api/v2/automation", withoutResource((*Server).automation)},
	{routeListDestinations, "GET /api/v2/destinations", withoutResource((*Server).listDestinations)},
	{routeGetSettings, "GET /api/v2/settings", withoutResource((*Server).getSettings)},
	{routePutSettings, "PUT /api/v2/settings", withoutResource((*Server).putSettings)},
	{routeRefreshSettings, "POST /api/v2/settings/media/refresh", withoutResource((*Server).refreshSettings)},
	{routeDownloadOutput, "GET /media/v2/jobs/{jobId}/outputs/{position}", (*Server).downloadOutput},
	{routeDownloadBatch, "GET /media/v2/batches/{batchId}/download", (*Server).downloadBatch},
	{routeListBatches, "GET /api/v2/batches", withoutResource((*Server).listBatches)},
	{routeGetBatch, "GET /api/v2/batches/{batchId}", (*Server).getBatch},
	{routeCancelBatch, "DELETE /api/v2/batches/{batchId}", (*Server).cancelBatch},
	{routeRetryJob, "POST /api/v2/jobs/{jobId}/retry", (*Server).retryJob},
	{routeGetExportProposal, "GET /api/v2/export-proposals/{proposalId}", (*Server).getExportProposal},
	{routeApproveExportProposal, "POST /api/v2/export-proposals/{proposalId}/approval", (*Server).approveExportProposal},
	{routeGetMCPSettings, "GET /api/v2/settings/mcp", withoutResource((*Server).getMCPSettings)},
	{routeCreateMCPCredential, "POST /api/v2/settings/mcp/credentials", withoutResource((*Server).createMCPCredential)},
	{routeRevokeMCPCredential, "DELETE /api/v2/settings/mcp/credentials/{credentialId}", (*Server).revokeMCPCredential},
	{routeStreamBatch, "GET /api/v2/batches/{batchId}/events", (*Server).streamBatch},
}

func newRouteMux(server *Server) *http.ServeMux {
	mux := http.NewServeMux()
	for _, definition := range routeDefinitions {
		mux.HandleFunc(definition.pattern, func(w http.ResponseWriter, r *http.Request) {
			resource, valid := routeResource(r)
			if !valid || r.Method == http.MethodHead && definition.kind != routePreview {
				notFound(w, RequestIDFromContext(r.Context()))
				return
			}
			if observed, ok := w.(*statusWriter); ok {
				_, observed.route, _ = strings.Cut(definition.pattern, " ")
				if definition.kind == routeExportInterchange {
					observed.route = strings.Replace(observed.route, "/media/v2/", "/api/v2/", 1)
				}
			}
			definition.handler(server, w, r, resource, RequestIDFromContext(r.Context()))
		})
	}
	return mux
}

func routeResource(r *http.Request) (string, bool) {
	var resource string
	for _, field := range []struct {
		key   string
		valid func(string) bool
	}{
		{"mediaId", validMediaID}, {"projectId", validProjectID}, {"jobId", validJobID},
		{"batchId", validBatchID}, {"credentialId", validCredentialID}, {"proposalId", validProposalID},
	} {
		if value := r.PathValue(field.key); value != "" {
			if !field.valid(value) {
				return "", false
			}
			resource = value
		}
	}
	if format := r.PathValue("format"); format != "" {
		if format != "csv" && format != "chapters" {
			return "", false
		}
		resource += ":" + format
	}
	if position := r.PathValue("position"); position != "" {
		resource += ":" + position
	}
	return resource, true
}
