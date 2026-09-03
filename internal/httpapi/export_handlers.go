// Package httpapi implements HTTP transport handlers.
package httpapi

import (
	"io"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
)

func (s *Server) downloadOutput(w http.ResponseWriter, r *http.Request, encoded, id string) {
	if s.config.Download == nil {
		return
	}
	parts := strings.Split(encoded, ":")
	if len(parts) != 2 || !validJobID(parts[0]) {
		notFound(w, id)
		return
	}
	position, err := strconv.Atoi(parts[1])
	if err != nil || position < 0 || position > 99 {
		notFound(w, id)
		return
	}
	file, name, err := s.config.Download.Download(r.Context(), parts[0], position)
	if err != nil {
		notFound(w, id)
		return
	}
	defer file.Close()
	if !safeOutputName(name) {
		notFound(w, id)
		return
	}
	w.Header().Set("Content-Type", "video/x-matroska")
	w.Header().Set("Content-Disposition", `attachment; filename="`+name+`"`)
	w.WriteHeader(http.StatusOK)
	_, _ = io.Copy(w, file)
}

func safeOutputName(name string) bool {
	if name == "" || strings.ContainsAny(name, `/\\\"`) {
		return false
	}
	return filepath.Base(name) == name
}
