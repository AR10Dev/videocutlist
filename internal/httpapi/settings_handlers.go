// Package httpapi implements HTTP transport handlers.
package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"

	jobqueue "videocutlist/internal/jobs/model"
	settings "videocutlist/internal/settings"
	settingsmodel "videocutlist/internal/settings/model"
)

type settingsUpdateRequest struct {
	Revision int64                         `json:"revision"`
	Settings settingsmodel.RuntimeSettings `json:"settings"`
}

// browserSettings is intentionally a projection: deployment paths are never
// serialized into a browser response.
func browserSettings(settings settingsmodel.RuntimeSettings) map[string]any {
	data := map[string]any{}
	encoded, _ := json.Marshal(settings)
	_ = json.Unmarshal(encoded, &data)
	delete(data, "mediaRoots")
	destinations := make([]DestinationMetadata, 0, len(settings.Destinations))
	for _, destination := range settings.Destinations {
		destinations = append(destinations, DestinationMetadata{ID: destination.ID, Label: destination.Label, Description: destination.Description, Kind: destination.Kind, Retention: destination.Retention})
	}
	data["destinations"] = destinations
	return data
}

func (s *Server) getSettings(w http.ResponseWriter, r *http.Request, id string) {
	if s.config.Settings == nil {
		httpx.Error(w, http.StatusNotFound, "settings_unavailable", "Settings are not available.", id)
		return
	}
	record, err := s.config.Settings.Get(r.Context())
	if err != nil {
		internalServerError(w, http.StatusInternalServerError, "settings_unavailable", "Settings are temporarily unavailable.", id, err)
		return
	}
	roots := make(map[string]any, len(record.Settings.MediaRoots))
	for alias, path := range record.Settings.MediaRoots {
		state, message := "ready", "Media root is available to the server."
		info, statErr := os.Stat(path)
		if statErr != nil || !info.IsDir() {
			state, message = "unavailable", "Media root is not available to the server. Check the deployment mount or directory permissions."
		}
		roots[alias] = map[string]string{"state": state, "message": message}
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"settings": browserSettings(record.Settings), "revision": record.Revision, "schemaVersion": record.SchemaVersion,
		"updatedAt": record.UpdatedAt, "pathsConstrained": len(s.config.SettingsAllowlist) > 0, "roots": roots,
	})
}

func (s *Server) putSettings(w http.ResponseWriter, r *http.Request, id string) {
	if s.config.Settings == nil {
		httpx.Error(w, http.StatusNotFound, "settings_unavailable", "Settings are not available.", id)
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, MaxJSONBody+1))
	if err != nil || len(body) > MaxJSONBody {
		httpx.Error(w, http.StatusBadRequest, "invalid_settings", "Settings must be a complete valid document.", id)
		return
	}
	var input settingsUpdateRequest
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil || input.Revision < 1 {
		httpx.Error(w, http.StatusBadRequest, "invalid_settings", "Settings must be a complete valid document.", id)
		return
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		httpx.Error(w, http.StatusBadRequest, "invalid_settings", "Settings must be a complete valid document.", id)
		return
	}
	var complete struct {
		Settings struct {
			MCPEnabled *bool `json:"mcpEnabled"`
		} `json:"settings"`
	}
	if err := json.Unmarshal(body, &complete); err != nil || complete.Settings.MCPEnabled == nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_settings", "Settings must be a complete valid document.", id)
		return
	}
	var document struct {
		Settings settings.DeploymentDocument `json:"settings"`
	}
	if err := json.Unmarshal(body, &document); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_settings", "Settings must be a complete valid document.", id)
		return
	}
	record, err := s.config.Settings.Update(r.Context(), input.Revision, input.Settings, document.Settings)
	if err != nil {
		switch {
		case errors.Is(err, settingsmodel.ErrRuntimeSettingsRevisionConflict):
			httpx.Error(w, http.StatusConflict, "settings_revision_conflict", "Settings changed; reload before updating.", id)
		case errors.Is(err, settings.ErrDeploymentSettingsReadOnly):
			httpx.Error(w, http.StatusBadRequest, "deployment_settings_read_only", "Deployment paths and destinations are server-managed.", id)
		case errors.Is(err, settings.ErrInvalidSettings):
			httpx.Error(w, http.StatusBadRequest, "invalid_settings", "Settings could not be applied safely.", id)
		default:
			internalServerError(w, http.StatusInternalServerError, "settings_unavailable", "Settings are temporarily unavailable.", id, err)
		}
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"settings": browserSettings(record.Settings), "revision": record.Revision, "schemaVersion": record.SchemaVersion, "updatedAt": record.UpdatedAt})
}

func (s *Server) refreshSettings(w http.ResponseWriter, r *http.Request, id string) {
	key := r.Header.Get("Idempotency-Key")
	if !jobqueue.ValidCommandKey(key) {
		httpx.Error(w, http.StatusBadRequest, "invalid_idempotency_key", "A valid Idempotency-Key is required.", id)
		return
	}
	job, err := s.startMediaScan(r.Context(), key)
	if err != nil {
		switch {
		case errors.Is(err, jobqueue.ErrAdmissionConflict):
			httpx.Error(w, http.StatusConflict, "idempotency_conflict", "Idempotency-Key was already used for a different command.", id)
		case errors.Is(err, jobqueue.ErrQueueFull):
			httpx.Error(w, http.StatusTooManyRequests, "library_busy", "Library scan capacity is full.", id)
		default:
			httpx.Error(w, http.StatusConflict, "refresh_unavailable", "The media library could not be refreshed. Check the deployment mount or directory permissions.", id)
		}
		return
	}
	httpx.WriteJSON(w, http.StatusAccepted, job)
}
