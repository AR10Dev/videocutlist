// Package httpapi implements HTTP transport handlers.
package httpapi

import (
	"context"
	"errors"
	"net/http"

	jobqueue "videocutlist/internal/jobs"
	"videocutlist/internal/projects"
)

func (s *Server) browseMedia(writer http.ResponseWriter, request *http.Request, id string) {
	if !queryKeys(request, "folderId", "cursor", "limit") {
		httpx.Error(writer, 400, "invalid_query", "Query parameters are invalid.", id)
		return
	}
	q := request.URL.Query()
	folderID, cursor := q.Get("folderId"), q.Get("cursor")
	if folderID != "" && !validFolderID(folderID) || cursor != "" && !validMediaID(cursor) {
		httpx.Error(writer, 400, "invalid_query", "Query parameters are invalid.", id)
		return
	}
	limit, err := parseLimit(q.Get("limit"))
	if err != nil {
		httpx.Error(writer, 400, "invalid_query", "Query parameters are invalid.", id)
		return
	}
	page, err := s.config.Media.Browse(request.Context(), folderID, cursor, limit)
	if err != nil {
		internalError(writer, id)
		return
	}
	httpx.WriteJSON(writer, 200, page)
}

func (s *Server) listMedia(writer http.ResponseWriter, request *http.Request, id string) {
	if !queryKeys(request, "limit", "cursor") {
		httpx.Error(writer, 400, "invalid_query", "Query parameters are invalid.", id)
		return
	}
	limit, err := parseLimit(request.URL.Query().Get("limit"))
	if err != nil {
		httpx.Error(writer, 400, "invalid_query", "Query parameters are invalid.", id)
		return
	}
	cursor := request.URL.Query().Get("cursor")
	if len(cursor) > 128 || cursor != "" && !validMediaID(cursor) {
		httpx.Error(writer, 400, "invalid_query", "Query parameters are invalid.", id)
		return
	}
	page, err := s.config.Media.List(request.Context(), cursor, limit)
	if err != nil {
		internalError(writer, id)
		return
	}
	httpx.WriteJSON(writer, 200, page)
}

func (s *Server) refreshMedia(writer http.ResponseWriter, request *http.Request, id string) {
	key := request.Header.Get("Idempotency-Key")
	if !jobqueue.ValidCommandKey(key) {
		httpx.Error(writer, http.StatusBadRequest, "invalid_idempotency_key", "A valid Idempotency-Key is required.", id)
		return
	}
	job, err := s.startMediaScan(request.Context(), key)
	if err != nil {
		writeMediaScanError(writer, err, id)
		return
	}
	httpx.WriteJSON(writer, http.StatusAccepted, job)
}

func (s *Server) startMediaScan(ctx context.Context, key string) (projects.ImportJob, error) {
	if s.config.MediaImport == nil {
		return projects.ImportJob{}, errors.New("unified media scan is not configured")
	}
	return s.config.MediaImport.StartImport(ctx, key)
}

func writeMediaScanError(writer http.ResponseWriter, err error, id string) {
	switch {
	case errors.Is(err, jobqueue.ErrAdmissionConflict):
		httpx.Error(writer, http.StatusConflict, "idempotency_conflict", "Idempotency-Key was already used for a different command.", id)
	case errors.Is(err, jobqueue.ErrQueueFull):
		httpx.Error(writer, http.StatusTooManyRequests, "library_busy", "Library scan capacity is full.", id)
	default:
		internalError(writer, id)
	}
}
func (s *Server) getMedia(writer http.ResponseWriter, request *http.Request, media string, id string) {
	result, err := s.config.Media.Get(request.Context(), media)
	if err != nil {
		resourceError(writer, id, err)
		return
	}
	httpx.WriteJSON(writer, 200, result)
}
