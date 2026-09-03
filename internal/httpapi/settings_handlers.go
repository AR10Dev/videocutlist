// Package httpapi implements HTTP transport handlers.
package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"reflect"

	store "videocutlist/internal/db"
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
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
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
	s.settingsMu.Lock()
	defer s.settingsMu.Unlock()
	previous, err := s.config.Settings.Get(r.Context())
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "settings_unavailable", "Settings are temporarily unavailable.", id)
		return
	}
	if previous.Revision != input.Revision {
		httpx.Error(w, http.StatusConflict, "settings_revision_conflict", "Settings changed; reload before updating.", id)
		return
	}
	// Deployment paths and destinations are server-owned. Browser responses omit
	// them, so preserve those values while rejecting attempts to change them.
	var document struct {
		Settings struct {
			MediaRoots   json.RawMessage `json:"mediaRoots"`
			Destinations json.RawMessage `json:"destinations"`
		} `json:"settings"`
	}
	if err := json.Unmarshal(body, &document); err != nil || len(document.Settings.MediaRoots) > 0 && !jsonEqual(document.Settings.MediaRoots, previous.Settings.MediaRoots) || len(document.Settings.Destinations) > 0 && !destinationsMatch(document.Settings.Destinations, previous.Settings.Destinations) {
		httpx.Error(w, http.StatusUnprocessableEntity, "deployment_settings_read_only", "Deployment paths and destinations are server-managed.", id)
		return
	}
	input.Settings.MediaRoots = previous.Settings.MediaRoots
	input.Settings.Destinations = previous.Settings.Destinations
	if s.config.ApplyRuntimeSettings != nil {
		if err := s.config.ApplyRuntimeSettings(input.Settings); err != nil {
			httpx.Error(w, http.StatusUnprocessableEntity, "invalid_settings", "Settings could not be applied safely.", id)
			return
		}
	}
	record, err := s.config.Settings.Update(r.Context(), input.Revision, input.Settings)
	if err != nil {
		if s.config.ApplyRuntimeSettings != nil {
			if rollbackErr := s.config.ApplyRuntimeSettings(previous.Settings); rollbackErr != nil {
				httpx.Error(w, http.StatusInternalServerError, "settings_unavailable", "Settings could not be restored safely.", id)
				return
			}
		}
		if errors.Is(err, store.ErrRuntimeSettingsRevisionConflict) {
			httpx.Error(w, http.StatusConflict, "settings_revision_conflict", "Settings changed; reload before updating.", id)
			return
		}
		httpx.Error(w, http.StatusUnprocessableEntity, "invalid_settings", "Settings must be a complete valid document.", id)
		return
	}
	if s.config.RuntimeSettings != nil {
		s.config.RuntimeSettings.Replace(record.Settings)
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"settings": browserSettings(record.Settings), "revision": record.Revision, "schemaVersion": record.SchemaVersion, "updatedAt": record.UpdatedAt})
}

func jsonEqual(raw json.RawMessage, value any) bool {
	var got, want any
	encoded, err := json.Marshal(value)
	if err != nil || json.Unmarshal(raw, &got) != nil || json.Unmarshal(encoded, &want) != nil {
		return false
	}
	return reflect.DeepEqual(got, want)
}

func destinationsMatch(raw json.RawMessage, previous []store.RuntimeDestination) bool {
	var got []map[string]json.RawMessage
	if json.Unmarshal(raw, &got) != nil || len(got) != len(previous) {
		return false
	}
	for i, destination := range previous {
		var metadata DestinationMetadata
		encoded, err := json.Marshal(got[i])
		if err != nil || json.Unmarshal(encoded, &metadata) != nil || metadata != (DestinationMetadata{ID: destination.ID, Label: destination.Label, Description: destination.Description, Kind: destination.Kind, Retention: destination.Retention}) {
			return false
		}
		for name, value := range map[string]string{"root": destination.Root, "mediaRoot": destination.MediaRoot} {
			if supplied, ok := got[i][name]; ok && !jsonEqual(supplied, value) {
				return false
			}
		}
	}
	return true
}

func (s *Server) refreshSettings(w http.ResponseWriter, r *http.Request, id string) {
	job, err := s.startMediaScan(r.Context())
	if err != nil {
		httpx.Error(w, http.StatusConflict, "refresh_unavailable", "The media library could not be refreshed. Check the deployment mount or directory permissions.", id)
		return
	}
	httpx.WriteJSON(w, http.StatusAccepted, job)
}
