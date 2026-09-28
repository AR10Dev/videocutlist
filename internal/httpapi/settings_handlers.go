// Package httpapi implements HTTP transport handlers.
package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"

	store "videocutlist/internal/db"
	settings "videocutlist/internal/settings"
)

type settingsUpdateRequest struct {
	Revision int64                 `json:"revision"`
	Settings store.RuntimeSettings `json:"settings"`
}

// browserSettings is intentionally a projection: deployment paths are never
// serialized into a browser response.
func browserSettings(settings store.RuntimeSettings) map[string]any {
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
		httpx.Error(w, http.StatusInternalServerError, "settings_unavailable", "Settings are temporarily unavailable.", id)
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
		httpx.Error(w, http.StatusUnprocessableEntity, "invalid_settings", "Settings must be a complete valid document.", id)
		return
	}
	var input settingsUpdateRequest
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil || input.Revision < 1 {
		httpx.Error(w, http.StatusUnprocessableEntity, "invalid_settings", "Settings must be a complete valid document.", id)
		return
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		httpx.Error(w, http.StatusUnprocessableEntity, "invalid_settings", "Settings must be a complete valid document.", id)
		return
	}
	var complete struct {
		Settings struct {
			MCPEnabled *bool `json:"mcpEnabled"`
		} `json:"settings"`
	}
	if err := json.Unmarshal(body, &complete); err != nil || complete.Settings.MCPEnabled == nil {
		httpx.Error(w, http.StatusUnprocessableEntity, "invalid_settings", "Settings must be a complete valid document.", id)
		return
	}
	var document struct {
		Settings settings.DeploymentDocument `json:"settings"`
	}
	if err := json.Unmarshal(body, &document); err != nil {
		httpx.Error(w, http.StatusUnprocessableEntity, "invalid_settings", "Settings must be a complete valid document.", id)
		return
	}
	record, err := s.config.Settings.Update(r.Context(), input.Revision, input.Settings, document.Settings)
	if err != nil {
		switch {
		case errors.Is(err, store.ErrRuntimeSettingsRevisionConflict):
			httpx.Error(w, http.StatusConflict, "settings_revision_conflict", "Settings changed; reload before updating.", id)
		case errors.Is(err, settings.ErrDeploymentSettingsReadOnly):
			httpx.Error(w, http.StatusUnprocessableEntity, "deployment_settings_read_only", "Deployment paths and destinations are server-managed.", id)
		case errors.Is(err, settings.ErrInvalidSettings):
			httpx.Error(w, http.StatusUnprocessableEntity, "invalid_settings", "Settings could not be applied safely.", id)
		default:
			httpx.Error(w, http.StatusInternalServerError, "settings_unavailable", "Settings are temporarily unavailable.", id)
		}
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"settings": browserSettings(record.Settings), "revision": record.Revision, "schemaVersion": record.SchemaVersion, "updatedAt": record.UpdatedAt})
}

func (s *Server) refreshSettings(w http.ResponseWriter, r *http.Request, id string) {
	job, err := s.startMediaScan(r.Context())
	if err != nil {
		httpx.Error(w, http.StatusConflict, "refresh_unavailable", "The media library could not be refreshed. Check the deployment mount or directory permissions.", id)
		return
	}
	httpx.WriteJSON(w, http.StatusAccepted, job)
}
