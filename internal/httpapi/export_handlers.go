// Package httpapi implements HTTP transport handlers.
package httpapi

import (
	"io"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"

	"videocutlist/internal/contextio"
	"videocutlist/internal/exportpolicy"
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
	if err != nil || position < 0 || position >= exportpolicy.MaxOutputs {
		notFound(w, id)
		return
	}
	file, name, err := s.config.Download.Download(r.Context(), parts[0], position)
	if err != nil {
		notFound(w, id)
		return
	}
	defer closeResponseBody(s.config.Logger, "download_output", file)
	writeAttachment(w, id, name, exportpolicy.MIMEForOutputName(name), file)
}

// downloadBatch streams the authenticated, validated batch archive.
func (s *Server) downloadBatch(w http.ResponseWriter, r *http.Request, batchID, id string) {
	if s.config.BatchDownload == nil {
		notFound(w, id)
		return
	}
	file, name, err := s.config.BatchDownload.DownloadBatch(r.Context(), batchID)
	if err != nil {
		notFound(w, id)
		return
	}
	defer closeResponseBody(s.config.Logger, "download_batch", file)
	writeAttachment(w, id, name, "application/zip", contextio.NewReader(r.Context(), file))
}

func writeAttachment(w http.ResponseWriter, id, name, mime string, body io.Reader) {
	if !safeOutputName(name) {
		notFound(w, id)
		return
	}
	w.Header().Set("Content-Type", mime)
	w.Header().Set("Content-Disposition", `attachment; filename="`+name+`"`)
	w.WriteHeader(http.StatusOK)
	_, _ = io.Copy(w, body)
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
