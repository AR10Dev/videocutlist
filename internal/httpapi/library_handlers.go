// Package httpapi implements HTTP transport handlers.
package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strconv"

	"videocutlist/internal/projects"
)

func (s *Server) browseMedia(writer http.ResponseWriter, request *http.Request, id string) {
	if !queryKeys(request, "folderId", "cursor", "limit") {
		httpx.Error(writer, 422, "invalid_query", "Query parameters are invalid.", id)
		return
	}
	q := request.URL.Query()
	folderID, cursor := q.Get("folderId"), q.Get("cursor")
	if folderID != "" && !validFolderID(folderID) || cursor != "" && !validMediaID(cursor) {
		httpx.Error(writer, 422, "invalid_query", "Query parameters are invalid.", id)
		return
	}
	limit := 50
	var err error
	if q.Get("limit") != "" {
		limit, err = strconv.Atoi(q.Get("limit"))
		if err != nil || limit < 1 || limit > 100 {
			httpx.Error(writer, 422, "invalid_query", "Query parameters are invalid.", id)
			return
		}
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
		httpx.Error(writer, 422, "invalid_query", "Query parameters are invalid.", id)
		return
	}
	limit := 50
	var err error
	if value := request.URL.Query().Get("limit"); value != "" {
		limit, err = strconv.Atoi(value)
		if err != nil || limit < 1 || limit > 100 {
			httpx.Error(writer, 422, "invalid_query", "Query parameters are invalid.", id)
			return
		}
	}
	cursor := request.URL.Query().Get("cursor")
	if len(cursor) > 128 || cursor != "" && !validMediaID(cursor) {
		httpx.Error(writer, 422, "invalid_query", "Query parameters are invalid.", id)
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
	job, err := s.startMediaScan(request.Context())
	if err != nil {
		internalError(writer, id)
		return
	}
	httpx.WriteJSON(writer, http.StatusAccepted, job)
}

func (s *Server) startMediaScan(ctx context.Context) (projects.ImportJob, error) {
	if s.config.MediaImport == nil {
		return projects.ImportJob{}, errors.New("unified media scan is not configured")
	}
	return s.config.MediaImport.StartImport(ctx)
}
func (s *Server) getMedia(writer http.ResponseWriter, request *http.Request, media string, id string) {
	result, err := s.config.Media.Get(request.Context(), media)
	if err != nil {
		notFound(writer, id)
		return
	}
	httpx.WriteJSON(writer, 200, result)
}
