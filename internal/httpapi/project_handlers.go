// Package httpapi implements HTTP transport handlers.
package httpapi

import (
	"errors"
	"net/http"

	store "videocutlist/internal/db"
	"videocutlist/internal/detection"
	"videocutlist/internal/httpapi/transport"
	jobs "videocutlist/internal/jobs"
	jobqueue "videocutlist/internal/jobs/model"
	"videocutlist/internal/projects"
)

func (s *Server) listProjects(writer http.ResponseWriter, request *http.Request, id string) {
	service, ok := s.config.Projects.(projects.ProjectListService)
	if !ok {
		internalError(writer, id, nil)
		return
	}
	query := request.URL.Query()
	if !queryKeys(request, "cursor", "limit") {
		httpx.Error(writer, http.StatusBadRequest, "invalid_query", "Invalid query.", id)
		return
	}
	limit, err := parseLimit(query.Get("limit"))
	if err != nil {
		httpx.Error(writer, http.StatusBadRequest, "invalid_query", "Invalid query.", id)
		return
	}
	page, err := service.List(request.Context(), query.Get("cursor"), limit)
	if err != nil {
		internalError(writer, id, err)
		return
	}
	writeProjectPageJSON(writer, id, page)
}

func (s *Server) getProject(writer http.ResponseWriter, request *http.Request, project string, id string) {
	value, err := s.config.Projects.Get(request.Context(), project)
	if err != nil {
		resourceError(writer, id, err)
		return
	}
	writeProjectJSON(writer, http.StatusOK, id, value)
}
func (s *Server) putProject(writer http.ResponseWriter, request *http.Request, project string, id string) {
	var input ProjectInput
	if httpx.ReadJSON(request, &input) != nil {
		httpx.Error(writer, 400, "invalid_project", "Project data could not be read. Reload the page and try again.", id)
		return
	}
	saved, err := s.config.Projects.Save(request.Context(), project, input.input())
	if err != nil {
		projectError(writer, id, err)
		return
	}
	writeProjectJSON(writer, http.StatusOK, id, saved)
}
func (s *Server) listBatches(writer http.ResponseWriter, request *http.Request, id string) {
	if s.config.BatchExports == nil {
		internalError(writer, id, nil)
		return
	}
	if !queryKeys(request, "cursor", "limit") {
		httpx.Error(writer, http.StatusBadRequest, "invalid_query", "Invalid query.", id)
		return
	}
	query := request.URL.Query()
	limit, err := parseLimit(query.Get("limit"))
	cursor := query.Get("cursor")
	if err != nil || len(cursor) > 256 {
		httpx.Error(writer, http.StatusBadRequest, "invalid_query", "Invalid query.", id)
		return
	}
	page, err := s.config.BatchExports.List(request.Context(), cursor, limit)
	if errors.Is(err, projects.ErrInvalidBatchCursor) {
		httpx.Error(writer, http.StatusBadRequest, "invalid_query", "Invalid query.", id)
		return
	}
	if err != nil {
		internalError(writer, id, err)
		return
	}
	writeBatchPageJSON(writer, id, page)
}

func (s *Server) getBatch(writer http.ResponseWriter, request *http.Request, batchID string, id string) {
	if s.config.BatchExports == nil {
		internalError(writer, id, nil)
		return
	}
	batch, err := s.config.BatchExports.Get(request.Context(), batchID)
	if err != nil {
		resourceError(writer, id, err)
		return
	}
	writeBatchJSON(writer, http.StatusOK, id, batch)
}

func (s *Server) retryJob(writer http.ResponseWriter, request *http.Request, jobID string, id string) {
	if s.config.BatchExports == nil {
		internalError(writer, id, nil)
		return
	}
	key := request.Header.Get("Idempotency-Key")
	if !jobqueue.ValidCommandKey(key) {
		httpx.Error(writer, http.StatusBadRequest, "invalid_idempotency_key", "A valid Idempotency-Key is required.", id)
		return
	}
	batch, err := s.config.BatchExports.Retry(request.Context(), jobID, key)
	if err != nil {
		switch {
		case errors.Is(err, jobqueue.ErrJobState):
			httpx.Error(writer, http.StatusConflict, "job_not_retryable", "Only failed export jobs can be retried.", id)
		case errors.Is(err, jobqueue.ErrAdmissionConflict):
			httpx.Error(writer, http.StatusConflict, "idempotency_conflict", "Idempotency-Key was already used for a different command.", id)
		default:
			resourceError(writer, id, err)
		}
		return
	}
	writeBatchJSON(writer, http.StatusAccepted, id, batch)
}

func (s *Server) cancelBatch(writer http.ResponseWriter, request *http.Request, batchID string, id string) {
	if s.config.BatchExports == nil {
		internalError(writer, id, nil)
		return
	}
	if err := s.config.BatchExports.Cancel(request.Context(), batchID); err != nil {
		resourceError(writer, id, err)
		return
	}
	writer.WriteHeader(http.StatusNoContent)
}

func (s *Server) getExportCapabilities(writer http.ResponseWriter, request *http.Request, mediaID string, id string) {
	if s.config.ExportCapabilities == nil {
		internalError(writer, id, nil)
		return
	}
	capabilities, err := s.config.ExportCapabilities.Capabilities(request.Context(), mediaID)
	if err != nil {
		resourceError(writer, id, err)
		return
	}
	httpx.WriteJSON(writer, http.StatusOK, exportCapabilitiesTransport(capabilities))
}

func (s *Server) preflightExport(writer http.ResponseWriter, request *http.Request, project string, id string) {
	if s.config.Preflight == nil {
		internalError(writer, id, nil)
		return
	}
	owned, err := s.config.Projects.Get(request.Context(), project)
	if err != nil {
		resourceError(writer, id, err)
		return
	}
	var requestBody transport.ExportInput
	if httpx.ReadJSON(request, &requestBody) != nil {
		httpx.Error(writer, 400, "invalid_export", "Export is invalid.", id)
		return
	}
	input := domainExportInput(requestBody)
	if !validExport(input) {
		httpx.Error(writer, 400, "invalid_export", "Export is invalid.", id)
		return
	}
	result, err := s.config.Preflight.Preflight(request.Context(), owned, input)
	if err != nil {
		httpx.Error(writer, 400, "preflight_failed", "Export preflight failed.", id)
		return
	}
	httpx.WriteJSON(writer, http.StatusOK, exportPreflightTransport(result))
}
func (s *Server) createExport(writer http.ResponseWriter, request *http.Request, project string, id string) {
	if s.config.BatchExports == nil {
		internalError(writer, id, nil)
		return
	}
	key := request.Header.Get("Idempotency-Key")
	if !jobqueue.ValidCommandKey(key) {
		httpx.Error(writer, http.StatusBadRequest, "invalid_idempotency_key", "A valid Idempotency-Key is required.", id)
		return
	}
	var input ExportSubmissionInput
	if httpx.ReadJSON(request, &input) != nil || input.ProjectRevision < 1 {
		httpx.Error(writer, http.StatusBadRequest, "invalid_export", "Export is invalid.", id)
		return
	}
	var itemIDs []string
	if input.ItemIds != nil {
		itemIDs = *input.ItemIds
	}
	batchID, submitted, err := s.config.BatchExports.Submit(request.Context(), projects.BatchExportRequest{ProjectID: project, IdempotencyKey: key, ProjectRevision: int64(input.ProjectRevision), ItemIDs: itemIDs})
	if err != nil {
		switch {
		case errors.Is(err, jobqueue.ErrQueueFull):
			httpx.Error(writer, http.StatusTooManyRequests, "export_busy", "Export capacity is full.", id)
		case errors.Is(err, projects.ErrInvalidProject):
			httpx.Error(writer, http.StatusBadRequest, "invalid_export", "Export is invalid.", id)
		case errors.Is(err, jobqueue.ErrAdmissionConflict):
			httpx.Error(writer, http.StatusConflict, "idempotency_conflict", "Idempotency-Key was already used for a different command.", id)
		case errors.Is(err, store.ErrRevisionConflict):
			httpx.Error(writer, http.StatusConflict, "stale_project", "Export request is stale.", id)
		default:
			resourceError(writer, id, err)
		}
		return
	}
	s.metrics.Add("export_jobs_total", uint64(len(submitted)))
	writeBatchExportSubmissionJSON(writer, id, batchID, submitted)
}
func (s *Server) createDetection(writer http.ResponseWriter, request *http.Request, project string, id string) {
	if s.config.Detection == nil {
		internalError(writer, id, nil)
		return
	}
	key := request.Header.Get("Idempotency-Key")
	if !jobqueue.ValidCommandKey(key) {
		httpx.Error(writer, http.StatusBadRequest, "invalid_idempotency_key", "A valid Idempotency-Key is required.", id)
		return
	}
	var requestBody transport.DetectionInput
	if httpx.ReadJSON(request, &requestBody) != nil {
		httpx.Error(writer, http.StatusBadRequest, "invalid_detection", "Detection request is invalid.", id)
		return
	}
	input := domainDetectionRequest(requestBody)
	if input.ProjectItemID == "" || detection.ValidateRequest(input) != nil {
		httpx.Error(writer, http.StatusBadRequest, "invalid_detection", "Detection request is invalid.", id)
		return
	}
	job, err := s.config.Detection.Submit(request.Context(), project, key, input)
	if err != nil {
		switch {
		case errors.Is(err, projects.ErrBusy), errors.Is(err, jobqueue.ErrQueueFull):
			httpx.Error(writer, http.StatusTooManyRequests, "detection_busy", "Detection capacity is full.", id)
		case errors.Is(err, jobqueue.ErrAdmissionConflict):
			httpx.Error(writer, http.StatusConflict, "idempotency_conflict", "Idempotency-Key was already used for a different command.", id)
		case errors.Is(err, store.ErrRevisionConflict), errors.Is(err, jobs.ErrSourceChanged):
			httpx.Error(writer, http.StatusConflict, "stale_project", "Detection request is stale.", id)
		case errors.Is(err, store.ErrProjectNotFound):
			resourceError(writer, id, err)
		default:
			resourceError(writer, id, err)
		}
		return
	}
	writeDetectionJobJSON(writer, http.StatusAccepted, id, job)
}
