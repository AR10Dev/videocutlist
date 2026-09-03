// Package httpapi implements HTTP transport handlers.
package httpapi

import (
	"net/http"
)

func (s *Server) getJob(writer http.ResponseWriter, request *http.Request, job string, id string) {
	if s.config.Jobs == nil {
		notFound(writer, id)
		return
	}
	value, err := s.config.Jobs.Get(request.Context(), job)
	if err != nil {
		notFound(writer, id)
		return
	}
	httpx.WriteJSON(writer, 200, value)
}
func (s *Server) cancelJob(writer http.ResponseWriter, request *http.Request, job string, id string) {
	if s.config.Jobs == nil {
		notFound(writer, id)
		return
	}
	if err := s.config.Jobs.Cancel(request.Context(), job); err != nil {
		notFound(writer, id)
		return
	}
	writer.WriteHeader(http.StatusNoContent)
}
