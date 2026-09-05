// Package httpapi implements HTTP transport handlers.
package httpapi

import (
	"context"
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

// downloadBatch streams the authenticated, validated batch archive.
func (s *Server) downloadBatch(w http.ResponseWriter, r *http.Request, batchID, id string) {
	service, ok := s.config.Download.(BatchDownloadService)
	if !ok {
		notFound(w, id)
		return
	}
	file, name, err := service.DownloadBatch(r.Context(), batchID)
	if err != nil {
		notFound(w, id)
		return
	}
	defer file.Close()
	if !safeOutputName(name) {
		notFound(w, id)
		return
	}
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", `attachment; filename="`+name+`"`)
	w.WriteHeader(http.StatusOK)
	_, _ = io.Copy(w, cancellableReader{ctx: r.Context(), reader: file})
}

type cancellableReader struct {
	ctx    context.Context
	reader io.Reader
}

func (r cancellableReader) Read(p []byte) (int, error) {
	select {
	case <-r.ctx.Done():
		return 0, r.ctx.Err()
	default:
		return r.reader.Read(p)
	}
}

func safeOutputName(name string) bool {
	if name == "" || name == "." || name == ".." || len(name) > 255 || strings.ContainsAny(name, `/\\\"`) {
		return false
	}
	for _, character := range name {
		if character < 32 || character == 127 {
			return false
		}
	}
	return filepath.Base(name) == name
}
