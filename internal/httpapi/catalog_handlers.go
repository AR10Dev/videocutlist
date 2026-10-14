package httpapi

import (
	"net/http"

	jobqueue "videocutlist/internal/jobs/model"
)

func (s *Server) listDestinations(w http.ResponseWriter, _ *http.Request, id string) {
	capabilities := DestinationCapabilities{}
	for _, destination := range s.config.Destinations {
		if destination.Kind == "source_adjacent" {
			capabilities.SaveBesideSource = true
			break
		}
	}
	httpx.WriteJSON(w, http.StatusOK, destinationsToTransport(s.config.Destinations, capabilities))
}

func (s *Server) mediaStatus(w http.ResponseWriter, _ *http.Request, _ string) {
	// The current response includes root diagnostics absent from generated LibraryStatus.
	WriteJSON(w, http.StatusOK, s.config.Media.Status())
}

func (s *Server) startImport(w http.ResponseWriter, r *http.Request, id string) {
	key := r.Header.Get("Idempotency-Key")
	if !jobqueue.ValidCommandKey(key) {
		Error(w, http.StatusBadRequest, "invalid_idempotency_key", "A valid Idempotency-Key is required.", id)
		return
	}
	if s.config.MediaImport == nil {
		Error(w, http.StatusConflict, "import_unavailable", "Import could not be started.", id)
		return
	}
	job, err := s.startMediaScan(r.Context(), key)
	if err != nil {
		writeMediaScanError(w, err, id)
		return
	}
	writeImportJobJSON(w, http.StatusAccepted, job)
}

func (s *Server) getImport(w http.ResponseWriter, r *http.Request, jobID, id string) {
	if s.config.MediaImport == nil {
		notFound(w, id)
		return
	}
	job, err := s.config.MediaImport.ImportStatus(r.Context(), jobID)
	if err != nil {
		resourceError(w, id, err)
		return
	}
	writeImportJobJSON(w, http.StatusOK, job)
}

func (s *Server) cancelImport(w http.ResponseWriter, r *http.Request, jobID, id string) {
	if s.config.MediaImport == nil {
		notFound(w, id)
		return
	}
	if err := s.config.MediaImport.CancelImport(r.Context(), jobID); err != nil {
		resourceError(w, id, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
