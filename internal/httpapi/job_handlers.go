// Package httpapi implements HTTP transport handlers.
package httpapi

import (
	"errors"
	"net/http"

	jobqueue "videocutlist/internal/jobs"
)

func (s *Server) getJob(writer http.ResponseWriter, request *http.Request, job string, id string) {
	if s.config.Jobs == nil {
		internalError(writer, id)
		return
	}
	value, err := s.config.Jobs.Get(request.Context(), job)
	if err != nil {
		if errors.Is(err, jobqueue.ErrJobNotFound) {
			notFound(writer, id)
		} else {
			internalError(writer, id)
		}
		return
	}
	httpx.WriteJSON(writer, 200, value)
}
func (s *Server) cancelJob(writer http.ResponseWriter, request *http.Request, job string, id string) {
	if s.config.Jobs == nil {
		internalError(writer, id)
		return
	}
	if err := s.config.Jobs.Cancel(request.Context(), job); err != nil {
		if errors.Is(err, jobqueue.ErrJobNotFound) {
			notFound(writer, id)
		} else {
			internalError(writer, id)
		}
		return
	}
	writer.WriteHeader(http.StatusNoContent)
}
