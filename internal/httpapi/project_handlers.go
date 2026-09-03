// Package httpapi implements HTTP transport handlers.
package httpapi

import (
	"errors"
	"net/http"
	"strconv"

	store "videocutlist/internal/db"
	jobqueue "videocutlist/internal/jobs"
	"videocutlist/internal/projects"
)

func (s *Server) listProjects(writer http.ResponseWriter, request *http.Request, id string) {
	service, ok := s.config.Projects.(projects.ProjectListService)
	if !ok {
		internalError(writer, id)
		return
	}
	query := request.URL.Query()
	if !queryKeys(request, "cursor", "limit") {
		httpx.Error(writer, http.StatusBadRequest, "invalid_query", "Invalid query.", id)
		return
	}
	limit := 50
	var err error
	if value := query.Get("limit"); value != "" {
		limit, err = strconv.Atoi(value)
		if err != nil || limit < 1 || limit > 100 {
			httpx.Error(writer, http.StatusBadRequest, "invalid_query", "Invalid query.", id)
			return
		}
	}
	page, err := service.List(request.Context(), query.Get("cursor"), limit)
	if err != nil {
		internalError(writer, id)
		return
	}
	httpx.WriteJSON(writer, http.StatusOK, page)
}

func (s *Server) getProject(writer http.ResponseWriter, request *http.Request, project string, id string) {
	value, err := s.config.Projects.Get(request.Context(), project)
	if err != nil {
		notFound(writer, id)
		return
	}
	httpx.WriteJSON(writer, 200, value)
}
func (s *Server) putProject(writer http.ResponseWriter, request *http.Request, project string, id string) {
	var input ProjectInput
	if httpx.ReadJSON(request, &input) != nil {
		httpx.Error(writer, 422, "invalid_project", "Project is invalid.", id)
		return
	}
	saved, err := s.config.Projects.Save(request.Context(), project, input.input())
	if err != nil {
		if errors.Is(err, store.ErrRevisionConflict) {
			httpx.Error(writer, http.StatusConflict, "revision_conflict", "Project revision conflicts.", id)
		} else {
			httpx.Error(writer, http.StatusUnprocessableEntity, "invalid_project", "Project is invalid.", id)
		}
		return
	}
	httpx.WriteJSON(writer, 200, saved)
}
func (s *Server) listBatches(writer http.ResponseWriter, request *http.Request, id string) {
	if s.config.BatchExports == nil {
		internalError(writer, id)
		return
	}
	limit := 50
	if value := request.URL.Query().Get("limit"); value != "" {
		var err error
		limit, err = strconv.Atoi(value)
		if err != nil || limit < 1 || limit > 100 {
			httpx.Error(writer, http.StatusBadRequest, "invalid_query", "Invalid query.", id)
			return
		}
	}
	page, err := s.config.BatchExports.List(request.Context(), limit)
	if err != nil {
		internalError(writer, id)
		return
	}
	httpx.WriteJSON(writer, http.StatusOK, page)
}

func (s *Server) getBatch(writer http.ResponseWriter, request *http.Request, batchID string, id string) {
	if s.config.BatchExports == nil {
		internalError(writer, id)
		return
	}
	batch, err := s.config.BatchExports.Get(request.Context(), batchID)
	if err != nil {
		notFound(writer, id)
		return
	}
	httpx.WriteJSON(writer, http.StatusOK, batch)
}

func (s *Server) retryJob(writer http.ResponseWriter, request *http.Request, jobID string, id string) {
	if s.config.BatchExports == nil {
		internalError(writer, id)
		return
	}
	batch, err := s.config.BatchExports.Retry(request.Context(), jobID)
	if err != nil {
		if errors.Is(err, jobqueue.ErrJobState) {
			httpx.Error(writer, http.StatusConflict, "job_not_retryable", "Only failed export jobs can be retried.", id)
		} else {
			notFound(writer, id)
		}
		return
	}
	httpx.WriteJSON(writer, http.StatusAccepted, batch)
}

func (s *Server) cancelBatch(writer http.ResponseWriter, request *http.Request, batchID string, id string) {
	if s.config.BatchExports == nil {
		if s.config.BatchExports == nil {
			internalError(writer, id)
		}
		return
	}
	if err := s.config.BatchExports.Cancel(request.Context(), batchID); err != nil {
		notFound(writer, id)
		return
	}
	writer.WriteHeader(http.StatusNoContent)
}

func (s *Server) preflightExport(writer http.ResponseWriter, request *http.Request, project string, id string) {
	if s.config.Preflight == nil {
		if s.config.Preflight == nil {
			internalError(writer, id)
		}
		return
	}
	owned, err := s.config.Projects.Get(request.Context(), project)
	if err != nil {
		notFound(writer, id)
		return
	}
	var input ExportInput
	if httpx.ReadJSON(request, &input) != nil || !validExport(input) {
		httpx.Error(writer, 422, "invalid_export", "Export is invalid.", id)
		return
	}
	result, err := s.config.Preflight.Preflight(request.Context(), project, owned, input)
	if err != nil {
		httpx.Error(writer, 422, "preflight_failed", "Export preflight failed.", id)
		return
	}
	httpx.WriteJSON(writer, 200, result)
}
func (s *Server) createExport(writer http.ResponseWriter, request *http.Request, project string, id string) {
	var input ExportInput
	if httpx.ReadJSON(request, &input) != nil {
		httpx.Error(writer, http.StatusUnprocessableEntity, "invalid_export", "Export is invalid.", id)
		return
	}
	batchID, submitted, err := s.config.BatchExports.Submit(request.Context(), projects.BatchExportRequest{ProjectID: project, ItemIDs: input.ItemIDs})
	if err != nil {
		if errors.Is(err, jobqueue.ErrQueueFull) {
			httpx.Error(writer, http.StatusTooManyRequests, "export_busy", "Export capacity is full.", id)
		} else {
			httpx.Error(writer, http.StatusUnprocessableEntity, "invalid_export", "Export is invalid.", id)
		}
		return
	}
	s.metrics.Add("export_jobs_total", uint64(len(submitted)))
	httpx.WriteJSON(writer, http.StatusAccepted, map[string]any{"batchId": batchID, "jobs": submitted})
}
func (s *Server) createDetection(writer http.ResponseWriter, request *http.Request, project string, id string) {
	if s.config.Detection == nil {
		internalError(writer, id)
		return
	}
	owned, err := s.config.Projects.Get(request.Context(), project)
	if err != nil {
		notFound(writer, id)
		return
	}
	var input DetectionRequest
	if httpx.ReadJSON(request, &input) != nil || input.ProjectRevision != owned.Revision || !input.Kind.Valid() {
		httpx.Error(writer, http.StatusConflict, "stale_project", "Detection request is stale.", id)
		return
	}
	matched := false
	for _, item := range owned.Items {
		if item.ID == input.ProjectItemID && item.MediaID == input.MediaID {
			matched = true
			break
		}
	}
	if !matched {
		httpx.Error(writer, http.StatusConflict, "stale_project", "Detection request is stale.", id)
		return
	}
	job, err := s.config.Detection.Create(request.Context(), project, input)
	if err != nil {
		if errors.Is(err, projects.ErrBusy) {
			httpx.Error(writer, http.StatusTooManyRequests, "detection_busy", "Detection capacity is full.", id)
			return
		}
		httpx.Error(writer, http.StatusUnprocessableEntity, "invalid_detection", "Detection request is invalid.", id)
		return
	}
	httpx.WriteJSON(writer, http.StatusAccepted, job)
}
