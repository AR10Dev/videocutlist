// Package httpapi implements the frozen v1 HTTP contract without exposing media paths.
package httpapi

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"time"

	"videocutlist/application"
	"videocutlist/domain"
	"videocutlist/infrastructure/interchange"
	"videocutlist/infrastructure/store"
)

const (
	maxQueryBytes          = 4 << 10
	maxAutomationBodyBytes = interchange.MaxInputBytes
)

type Media = application.Media
type MediaPage = application.MediaPage
type FolderPage = application.FolderPage
type LibraryStatus = application.LibraryStatus
type LibraryState = application.LibraryState

const (
	LibraryUnconfigured   = application.LibraryUnconfigured
	LibraryScanning       = application.LibraryScanning
	LibraryReadyEmpty     = application.LibraryReadyEmpty
	LibraryReadyWithMedia = application.LibraryReadyWithMedia
	LibraryFailed         = application.LibraryFailed
)

type Segment = domain.Segment
type UIState = domain.UIState
type ProjectInput struct {
	MediaID  string    `json:"mediaId"`
	Revision int64     `json:"revision"`
	Segments []Segment `json:"segments"`
	UIState  UIState   `json:"uiState"`
}

func (p *ProjectInput) UnmarshalJSON(data []byte) error {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return err
	}
	for _, key := range []string{"mediaId", "revision", "segments", "uiState"} {
		if _, ok := fields[key]; !ok {
			return errors.New("missing project field")
		}
	}
	if len(fields) != 4 {
		return errors.New("unknown project field")
	}
	type input ProjectInput
	var decoded input
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&decoded); err != nil {
		return err
	}
	*p = ProjectInput(decoded)
	return nil
}

type Project = application.Project
type ExportInput = application.ExportInput

func legacyProject(document domain.Document) (domain.Document, error) {
	return domain.LegacyProject(document)
}

func legacyProjectError(w http.ResponseWriter, id string) {
	httpx.Error(w, http.StatusConflict, "legacy_project_multi_item", "This operation requires a single-item project.", id)
}

type Job = application.Job
type PreviewSpec = application.PreviewSpec
type PreviewResult = application.PreviewResult
type AssetSpec = application.AssetSpec
type AssetResult = application.AssetResult

// The interfaces are intentionally API-shaped adapters. Concrete domain wiring
// remains outside this package, and no original path crosses this boundary.
type MediaService = application.MediaService
type PreviewService = application.PreviewService
type AssetService = application.AssetService
type ProjectService = application.ProjectService
type ExportService = application.ExportService
type ExportPreflightService = application.ExportPreflightService
type JobService = application.JobService
type DetectionRequest = application.DetectionRequest
type DetectionJob = application.DetectionJob
type DetectionService interface {
	Create(context.Context, string, DetectionRequest) (DetectionJob, error)
	Get(context.Context, string) (DetectionJob, error)
	Cancel(context.Context, string) error
}
type DestinationMetadata struct {
	ID          string `json:"id"`
	Label       string `json:"label"`
	Description string `json:"description,omitempty"`
	Kind        string `json:"kind"`
	Retention   string `json:"retention,omitempty"`
}
type BatchExportService interface {
	Submit(context.Context, application.BatchExportRequest) (string, []application.Job, error)
	Progress(context.Context, string) (store.JobState, float64, error)
	Cancel(context.Context, string) error
}

type Config struct {
	Authenticator        Authenticator
	Media                MediaService
	MediaImport          application.MediaImportService
	Preview              PreviewService
	Assets               AssetService
	Projects             ProjectService
	Exports              ExportService
	BatchExports         BatchExportService
	Preflight            ExportPreflightService
	Jobs                 JobService
	Detection            DetectionService
	Download             application.ExportDownloadService
	Settings             *store.RuntimeSettingsStore
	RuntimeSettings      *store.RuntimeSettingsState
	ApplyRuntimeSettings func(store.RuntimeSettings) error
	SettingsAllowlist    []string
	Destinations         []DestinationMetadata
	Ready                func(context.Context) error
	Logger               *log.Logger
	Metrics              *Metrics
	BeforeMS             int64
	AfterMS              int64
	MaxPreviewMS         int64
	GridMS               int64
	// ListenerAddress gates the local-only automation command surface.
	ListenerAddress       string
	RequireAutomationAuth bool
}

type Server struct {
	config     Config
	metrics    *Metrics
	settingsMu sync.Mutex
}

func New(config Config) (*Server, error) {
	if config.Authenticator == nil || config.Media == nil || config.Preview == nil || config.Projects == nil || config.Exports == nil || config.Jobs == nil {
		return nil, errors.New("api dependencies are required")
	}
	if config.BeforeMS == 0 {
		config.BeforeMS = 2_000
	}
	if config.AfterMS == 0 {
		config.AfterMS = 6_000
	}
	if config.MaxPreviewMS == 0 {
		config.MaxPreviewMS = 15_000
	}
	if config.GridMS == 0 {
		config.GridMS = 500
	}
	if config.BeforeMS < 0 || config.AfterMS < 0 || config.MaxPreviewMS < 1 || config.GridMS < 1 || config.BeforeMS+config.AfterMS > config.MaxPreviewMS {
		return nil, errors.New("invalid preview configuration")
	}
	if config.Metrics == nil {
		config.Metrics = NewMetrics()
	}
	return &Server{config: config, metrics: config.Metrics}, nil
}

func (s *Server) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	started := time.Now()
	id := RequestID()
	writer.Header().Set("X-Request-ID", id)
	status := &statusWriter{ResponseWriter: writer, status: http.StatusOK}
	route, _ := s.dispatch(status, request, id)
	s.metrics.HTTP(route, request.Method, strconv.Itoa(status.status/100)+"xx", time.Since(started).Seconds())
	if s.config.Logger != nil {
		data, _ := json.Marshal(map[string]any{"request_id": id, "method": request.Method, "route": route, "status": status.status})
		s.config.Logger.Print(string(data))
	}
}

func (s *Server) dispatch(writer http.ResponseWriter, request *http.Request, id string) (string, string) {
	if request.URL.Path == "/metrics" && request.Method == http.MethodGet {
		writer.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
		s.metrics.WritePrometheus(writer)
		return "/metrics", ""
	}
	if request.URL.Path == "/api/v1/health" && request.Method == http.MethodGet {
		writer.WriteHeader(http.StatusOK)
		return "/api/v1/health", ""
	}
	if request.URL.Path == "/api/v1/ready" && request.Method == http.MethodGet {
		if s.config.Ready != nil && s.config.Ready(request.Context()) != nil {
			Error(writer, http.StatusServiceUnavailable, "not_ready", "Service is not ready.", id)
		} else {
			writer.WriteHeader(http.StatusOK)
		}
		return "/api/v1/ready", ""
	}
	if err := s.config.Authenticator.Authenticate(request); err != nil {
		Error(writer, http.StatusUnauthorized, "unauthenticated", "Authentication is required.", id)
		return routeFor(request.URL.Path), ""
	}
	r := parseRoute(request.Method, request.URL.EscapedPath())
	switch r.kind {
	case routeListDestinations:
		httpx.WriteJSON(writer, http.StatusOK, map[string]any{"destinations": s.config.Destinations})
		return "/api/v1/destinations", ""
	case routeGetSettings:
		s.getSettings(writer, request, id)
		return "/api/v1/settings", ""
	case routePutSettings:
		s.putSettings(writer, request, id)
		return "/api/v1/settings", ""
	case routeRefreshSettings:
		s.refreshSettings(writer, request, id)
		return "/api/v1/settings/media/refresh", ""
	case routeListMedia:
		s.listMedia(writer, request, id)
		return "/api/v1/media", ""
	case routeBrowseMedia:
		s.browseMedia(writer, request, id)
		return "/api/v1/media/tree", ""
	case routeMediaStatus:
		httpx.WriteJSON(writer, http.StatusOK, s.config.Media.Status())
		return "/api/v1/media/status", ""
	case routeRefreshMedia:
		s.refreshMedia(writer, request, id)
		return "/api/v1/media/refresh", ""
	case routeStartMediaImport:
		job, err := s.config.MediaImport.StartImport(request.Context())
		if err != nil {
			httpx.Error(writer, http.StatusConflict, "import_unavailable", "Import could not be started.", id)
			return "/api/v1/media/import", ""
		}
		httpx.WriteJSON(writer, http.StatusAccepted, job)
		return "/api/v1/media/import", ""
	case routeGetMediaImport:
		job, err := s.config.MediaImport.ImportStatus(request.Context(), r.id)
		if err != nil {
			notFound(writer, id)
			return "/api/v1/media/import/{jobId}", ""
		}
		httpx.WriteJSON(writer, http.StatusOK, job)
		return "/api/v1/media/import/{jobId}", ""
	case routeCancelMediaImport:
		if err := s.config.MediaImport.CancelImport(request.Context(), r.id); err != nil {
			notFound(writer, id)
			return "/api/v1/media/import/{jobId}", ""
		}
		writer.WriteHeader(http.StatusNoContent)
		return "/api/v1/media/import/{jobId}", ""
	case routeGetMedia:
		s.getMedia(writer, request, r.id, id)
		return "/api/v1/media/{mediaId}", ""
	case routePreview:
		s.preview(writer, request, r.id, id)
		return "/api/v1/media/{mediaId}/preview", ""
	case routeThumbnails:
		s.thumbnails(writer, request, r.id, id)
		return "/api/v1/media/{mediaId}/thumbnails", ""
	case routeWaveform:
		s.waveform(writer, request, r.id, id)
		return "/api/v1/media/{mediaId}/waveform", ""
	case routeGetProject:
		s.getProject(writer, request, r.id, id)
		return "/api/v1/projects/{projectId}", ""
	case routePutProject:
		s.putProject(writer, request, r.id, id)
		return "/api/v1/projects/{projectId}", ""
	case routeCreateExport:
		s.createExport(writer, request, r.id, id)
		return "/api/v1/projects/{projectId}/exports", ""
	case routeGetBatch:
		s.getBatch(writer, request, r.id, id)
		return "/api/v1/batches/{batchId}", ""
	case routeCancelBatch:
		s.cancelBatch(writer, request, r.id, id)
		return "/api/v1/batches/{batchId}", ""
	case routePreflightExport:
		s.preflightExport(writer, request, r.id, id)
		return "/api/v1/projects/{projectId}/exports/preflight", ""
	case routeImportInterchange:
		s.importInterchange(writer, request, r.id, id)
		return "/api/v1/projects/{projectId}/interchange/{format}", ""
	case routeExportInterchange:
		s.exportInterchange(writer, request, r.id, id)
		return "/api/v1/projects/{projectId}/interchange/{format}", ""
	case routeCreateDetection:
		s.createDetection(writer, request, r.id, id)
		return "/api/v1/projects/{projectId}/detections", ""
	case routeGetJob:
		s.getJob(writer, request, r.id, id)
		return "/api/v1/jobs/{jobId}", ""
	case routeDownloadOutput:
		s.downloadOutput(writer, request, r.id, id)
		return "/api/v1/jobs/{jobId}/outputs/{position}", ""
	case routeCancelJob:
		s.cancelJob(writer, request, r.id, id)
		return "/api/v1/jobs/{jobId}", ""
	case routeAutomation:
		s.automation(writer, request, id)
		return "/api/v1/automation", ""
	}
	httpx.Error(writer, http.StatusNotFound, "not_found", "Resource not found.", id)
	return routeFor(request.URL.Path), ""
}

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
	if err := s.config.Media.RefreshMedia(r.Context()); err != nil {
		httpx.Error(w, http.StatusConflict, "refresh_unavailable", "The media library could not be refreshed. Check the deployment mount or directory permissions.", id)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

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
	if err := s.config.Media.RefreshMedia(request.Context()); err != nil {
		internalError(writer, id)
		return
	}
	writer.WriteHeader(http.StatusNoContent)
}
func (s *Server) getMedia(writer http.ResponseWriter, request *http.Request, media string, id string) {
	result, err := s.config.Media.Get(request.Context(), media)
	if err != nil {
		notFound(writer, id)
		return
	}
	httpx.WriteJSON(writer, 200, result)
}

func (s *Server) preview(writer http.ResponseWriter, request *http.Request, media string, id string) {
	item, err := s.config.Media.Get(request.Context(), media)
	if err != nil {
		notFound(writer, id)
		return
	}
	spec, err := s.previewSpec(request, item)
	if err != nil {
		httpx.Error(writer, 422, "invalid_preview", "Preview parameters are invalid.", id)
		return
	}
	if request.Method == http.MethodHead {
		cached, err := s.config.Preview.Cached(request.Context(), spec)
		if err != nil {
			internalError(writer, id)
			return
		}
		if !cached {
			writer.WriteHeader(http.StatusNotFound)
			return
		}
		previewHeaders(writer, spec, "hit")
		writer.WriteHeader(http.StatusOK)
		return
	}
	result, err := s.config.Preview.Start(request.Context(), spec)
	if err != nil {
		httpx.Error(writer, http.StatusTooManyRequests, "preview_unavailable", "Preview is unavailable.", id)
		return
	}
	defer result.Reader.Close()
	previewHeaders(writer, PreviewSpec{StartMS: result.StartMS, WindowMS: result.DurationMS, OffsetMS: result.OffsetMS}, result.CacheStatus)
	writer.Header().Set("Content-Type", "video/mp4")
	writer.WriteHeader(http.StatusOK)
	s.metrics.Preview(result.CacheStatus)
	buffer := make([]byte, 32*1024)
	for {
		count, readErr := result.Reader.Read(buffer)
		if count > 0 {
			if _, err := writer.Write(buffer[:count]); err != nil {
				return
			}
			if flush, ok := writer.(http.Flusher); ok {
				flush.Flush()
			}
		}
		if readErr == io.EOF {
			return
		}
		if readErr != nil {
			s.metrics.Add("ffmpeg_failures_total", 1)
			return
		}
	}
}

func (s *Server) assetSpec(request *http.Request, item Media, waveform bool) (AssetSpec, error) {
	keys := []string{"startMs", "durationMs"}
	if waveform {
		keys = append(keys, "samples")
	} else {
		keys = append(keys, "count", "width")
	}
	if !queryKeys(request, keys...) {
		return AssetSpec{}, errors.New("unknown query")
	}
	q := request.URL.Query()
	start, err := requiredInt(q.Get("startMs"))
	if err != nil || start < 0 {
		return AssetSpec{}, errors.New("start")
	}
	duration, err := requiredInt(q.Get("durationMs"))
	if err != nil || duration < 1 || duration > 120000 {
		return AssetSpec{}, errors.New("duration")
	}
	spec := AssetSpec{MediaID: item.ID, StartMS: start, DurationMS: duration}
	if waveform {
		spec.Samples, err = strconv.Atoi(q.Get("samples"))
		if err != nil || spec.Samples < 16 || spec.Samples > 4096 {
			return AssetSpec{}, errors.New("samples")
		}
	} else {
		spec.Count, err = strconv.Atoi(q.Get("count"))
		if err != nil || spec.Count < 1 || spec.Count > 32 {
			return AssetSpec{}, errors.New("count")
		}
		spec.Width, err = strconv.Atoi(q.Get("width"))
		if err != nil || spec.Width < 80 || spec.Width > 320 {
			return AssetSpec{}, errors.New("width")
		}
	}
	if item.DurationMS < 1 || start >= item.DurationMS {
		return AssetSpec{}, errors.New("range")
	}
	if start+duration > item.DurationMS {
		spec.DurationMS = item.DurationMS - start
	}
	return spec, nil
}

func (s *Server) thumbnails(w http.ResponseWriter, r *http.Request, media, id string) {
	if s.config.Assets == nil {
		if s.config.Assets == nil {
			internalError(w, id)
		}
		return
	}
	item, err := s.config.Media.Get(r.Context(), media)
	if err != nil {
		notFound(w, id)
		return
	}
	spec, err := s.assetSpec(r, item, false)
	if err != nil {
		httpx.Error(w, 422, "invalid_asset", "Thumbnail parameters are invalid.", id)
		return
	}
	if assetNotModified(w, r, item, "thumbnails") {
		return
	}
	result, err := s.config.Assets.Thumbnails(r.Context(), spec)
	if err != nil {
		internalError(w, id)
		return
	}
	defer result.Reader.Close()
	w.Header().Set("Content-Type", "image/png")
	w.WriteHeader(http.StatusOK)
	_, _ = io.Copy(w, result.Reader)
}

func (s *Server) waveform(w http.ResponseWriter, r *http.Request, media, id string) {
	if s.config.Assets == nil {
		if s.config.Assets == nil {
			internalError(w, id)
		}
		return
	}
	item, err := s.config.Media.Get(r.Context(), media)
	if err != nil {
		notFound(w, id)
		return
	}
	if item.Streams["audio"] == nil {
		httpx.Error(w, 422, "no_audio", "Media has no audio stream.", id)
		return
	}
	spec, err := s.assetSpec(r, item, true)
	if err != nil {
		httpx.Error(w, 422, "invalid_asset", "Waveform parameters are invalid.", id)
		return
	}
	if assetNotModified(w, r, item, "waveform") {
		return
	}
	result, err := s.config.Assets.Waveform(r.Context(), spec)
	if errors.Is(err, application.ErrNoAudio) {
		httpx.Error(w, 422, "no_audio", "Media has no audio stream.", id)
		return
	}
	if err != nil {
		internalError(w, id)
		return
	}
	httpx.WriteJSON(w, 200, map[string]any{"startMs": result.StartMS, "durationMs": result.DurationMS, "peaks": result.Peaks})
}

func (s *Server) previewSpec(request *http.Request, item Media) (PreviewSpec, error) {
	beforeDefault, afterDefault, maxPreview, grid := s.config.BeforeMS, s.config.AfterMS, s.config.MaxPreviewMS, s.config.GridMS
	if s.config.RuntimeSettings != nil {
		settings := s.config.RuntimeSettings.Snapshot()
		beforeDefault, afterDefault, maxPreview, grid = int64(settings.PreviewBeforeMS), int64(settings.PreviewAfterMS), int64(settings.PreviewMaxMS), int64(settings.PreviewGridMS)
	}
	if !queryKeys(request, "centerMs", "beforeMs", "afterMs", "mute") {
		return PreviewSpec{}, errors.New("unknown query")
	}
	query := request.URL.Query()
	center, err := requiredInt(query.Get("centerMs"))
	if err != nil || center < 0 {
		return PreviewSpec{}, errors.New("center")
	}
	before, err := optionalInt(query.Get("beforeMs"), beforeDefault)
	if err != nil || before < 0 {
		return PreviewSpec{}, errors.New("before")
	}
	after, err := optionalInt(query.Get("afterMs"), afterDefault)
	if err != nil || after < 0 || before+after > maxPreview {
		return PreviewSpec{}, errors.New("after")
	}
	mute := false
	if value, ok := query["mute"]; ok {
		if len(value) != 1 {
			return PreviewSpec{}, errors.New("mute")
		}
		mute, err = strconv.ParseBool(value[0])
		if err != nil {
			return PreviewSpec{}, err
		}
	}
	if item.DurationMS < 1 {
		return PreviewSpec{}, errors.New("duration")
	}
	return application.NormalizePreview(item.ID, item.DurationMS, center, mute, domain.WindowConfig{BeforeMS: before, AfterMS: after, MaxMS: maxPreview, GridMS: grid})
}

func (s *Server) getProject(writer http.ResponseWriter, request *http.Request, project string, id string) {
	value, err := s.config.Projects.Get(request.Context(), project)
	if err != nil {
		notFound(writer, id)
		return
	}
	httpx.WriteJSON(writer, 200, value)
}
func (s *Server) putProject(writer http.ResponseWriter, request *http.Request, project string, id string) {
	var input ProjectInput
	if httpx.ReadJSON(request, &input) != nil {
		httpx.Error(writer, 422, "invalid_project", "Project is invalid.", id)
		return
	}
	if !validMediaID(input.MediaID) {
		httpx.Error(writer, 422, "invalid_project", "Project is invalid.", id)
		return
	}
	document := domain.Document{SchemaVersion: domain.ProjectSchemaVersion, Name: "Untitled project", Items: []domain.ProjectItem{{ID: domain.StableProjectItemID(project), MediaID: input.MediaID, Segments: input.Segments, EditorState: &input.UIState}}, Revision: input.Revision}
	document, _ = legacyProject(document)
	saved, err := s.config.Projects.Save(request.Context(), project, document)
	if err != nil {
		httpx.Error(writer, http.StatusConflict, "revision_conflict", "Project revision conflicts.", id)
		return
	}
	httpx.WriteJSON(writer, 200, saved)
}
func (s *Server) getBatch(writer http.ResponseWriter, request *http.Request, batchID string, id string) {
	if s.config.BatchExports == nil {
		if s.config.BatchExports == nil {
			internalError(writer, id)
		}
		return
	}
	state, progress, err := s.config.BatchExports.Progress(request.Context(), batchID)
	if err != nil {
		notFound(writer, id)
		return
	}
	httpx.WriteJSON(writer, http.StatusOK, map[string]any{"batchId": batchID, "state": state, "progress": progress})
}

func (s *Server) cancelBatch(writer http.ResponseWriter, request *http.Request, batchID string, id string) {
	if s.config.BatchExports == nil {
		if s.config.BatchExports == nil {
			internalError(writer, id)
		}
		return
	}
	if err := s.config.BatchExports.Cancel(request.Context(), batchID); err != nil {
		notFound(writer, id)
		return
	}
	writer.WriteHeader(http.StatusNoContent)
}

func (s *Server) preflightExport(writer http.ResponseWriter, request *http.Request, project string, id string) {
	if s.config.Preflight == nil {
		if s.config.Preflight == nil {
			internalError(writer, id)
		}
		return
	}
	owned, err := s.config.Projects.Get(request.Context(), project)
	if err != nil {
		notFound(writer, id)
		return
	}
	if owned.Document, err = legacyProject(owned.Document); err != nil {
		legacyProjectError(writer, id)
		return
	}
	var input ExportInput
	if httpx.ReadJSON(request, &input) != nil || !validExport(input) {
		httpx.Error(writer, 422, "invalid_export", "Export is invalid.", id)
		return
	}
	result, err := s.config.Preflight.Preflight(request.Context(), project, owned, input)
	if err != nil {
		httpx.Error(writer, 422, "preflight_failed", "Export preflight failed.", id)
		return
	}
	httpx.WriteJSON(writer, 200, result)
}
func (s *Server) createExport(writer http.ResponseWriter, request *http.Request, project string, id string) {
	if s.config.BatchExports != nil {
		var input ExportInput
		if httpx.ReadJSON(request, &input) != nil {
			httpx.Error(writer, http.StatusUnprocessableEntity, "invalid_export", "Export is invalid.", id)
			return
		}
		batchID, jobs, err := s.config.BatchExports.Submit(request.Context(), application.BatchExportRequest{ProjectID: project, ItemIDs: input.ItemIDs})
		if err != nil {
			if errors.Is(err, store.ErrQueueFull) {
				httpx.Error(writer, http.StatusTooManyRequests, "export_busy", "Export capacity is full.", id)
			} else {
				httpx.Error(writer, http.StatusUnprocessableEntity, "invalid_export", "Export is invalid.", id)
			}
			return
		}
		httpx.WriteJSON(writer, http.StatusAccepted, map[string]any{"batchId": batchID, "jobs": jobs})
		return
	}
	owned, err := s.config.Projects.Get(request.Context(), project)
	if err != nil {
		notFound(writer, id)
		return
	}
	if owned.Document, err = legacyProject(owned.Document); err != nil {
		legacyProjectError(writer, id)
		return
	}
	var input ExportInput
	if httpx.ReadJSON(request, &input) != nil || !validExport(input) {
		httpx.Error(writer, 422, "invalid_export", "Export is invalid.", id)
		return
	}
	job, err := s.config.Exports.Create(request.Context(), project, owned, input)
	if err != nil {
		if errors.Is(err, application.ErrBusy) {
			httpx.Error(writer, http.StatusTooManyRequests, "export_busy", "Export capacity is full.", id)
			return
		}
		internalError(writer, id)
		return
	}
	s.metrics.Add("export_jobs_total", 1)
	httpx.WriteJSON(writer, http.StatusAccepted, job)
}
func (s *Server) createDetection(writer http.ResponseWriter, request *http.Request, project string, id string) {
	if s.config.Detection == nil {
		internalError(writer, id)
		return
	}
	owned, err := s.config.Projects.Get(request.Context(), project)
	if err != nil {
		notFound(writer, id)
		return
	}
	if owned.Document, err = legacyProject(owned.Document); err != nil {
		legacyProjectError(writer, id)
		return
	}
	var input DetectionRequest
	if httpx.ReadJSON(request, &input) != nil || input.MediaID != owned.MediaID || input.ProjectRevision != owned.Revision || !input.Kind.Valid() {
		httpx.Error(writer, http.StatusConflict, "stale_project", "Detection request is stale.", id)
		return
	}
	job, err := s.config.Detection.Create(request.Context(), project, input)
	if err != nil {
		if errors.Is(err, application.ErrBusy) {
			httpx.Error(writer, http.StatusTooManyRequests, "detection_busy", "Detection capacity is full.", id)
			return
		}
		httpx.Error(writer, http.StatusUnprocessableEntity, "invalid_detection", "Detection request is invalid.", id)
		return
	}
	httpx.WriteJSON(writer, http.StatusAccepted, job)
}

type automationCommand struct {
	Action    string `json:"action"`
	ProjectID string `json:"projectId,omitempty"`
	JobID     string `json:"jobId,omitempty"`
	Format    string `json:"format,omitempty"`
	Input     string `json:"input,omitempty"`
}

func (s *Server) automation(w http.ResponseWriter, r *http.Request, id string) {
	if r.Header.Get("Origin") != "" || !listenerLoopback(s.config.ListenerAddress) || !s.config.RequireAutomationAuth {
		httpx.Error(w, http.StatusForbidden, "automation_forbidden", "Automation is unavailable.", id)
		return
	}
	if r.ContentLength > maxAutomationBodyBytes {
		httpx.Error(w, http.StatusRequestEntityTooLarge, "body_too_large", "Request body is too large.", id)
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, maxAutomationBodyBytes+1))
	if err != nil || len(body) > maxAutomationBodyBytes {
		httpx.Error(w, http.StatusRequestEntityTooLarge, "body_too_large", "Request body is too large.", id)
		return
	}
	var command automationCommand
	decoder := json.NewDecoder(strings.NewReader(string(body)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&command); err != nil || command.Action == "" {
		httpx.Error(w, http.StatusUnprocessableEntity, "invalid_command", "Command is invalid.", id)
		return
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		httpx.Error(w, http.StatusUnprocessableEntity, "invalid_command", "Command is invalid.", id)
		return
	}
	switch command.Action {
	case "project.import":
		if !validProjectID(command.ProjectID) || (command.Format != "csv" && command.Format != "chapters") || command.Input == "" {
			return
		}
		// Reuse the canonical HTTP interchange path and return only its opaque project ID.
		project, err := s.config.Projects.Get(r.Context(), command.ProjectID)
		if err != nil {
			notFound(w, id)
			return
		}
		if project.Document, err = legacyProject(project.Document); err != nil {
			legacyProjectError(w, id)
			return
		}
		media, err := s.config.Media.Get(r.Context(), project.MediaID)
		if err != nil {
			notFound(w, id)
			return
		}
		var segments []domain.Segment
		if command.Format == "csv" {
			segments, err = interchange.ParseCSV([]byte(command.Input), media.DurationMS)
		} else {
			segments, err = interchange.ParseChapters([]byte(command.Input), media.DurationMS)
		}
		if err != nil {
			httpx.Error(w, http.StatusUnprocessableEntity, "invalid_interchange", "Interchange input is invalid.", id)
			return
		}
		project.Document, err = domain.ReplaceLegacySegments(project.Document, segments)
		if err != nil {
			legacyProjectError(w, id)
			return
		}
		saved, err := s.config.Projects.Save(r.Context(), command.ProjectID, project.Document)
		if err != nil {
			httpx.Error(w, http.StatusConflict, "revision_conflict", "Project revision conflicts.", id)
			return
		}
		httpx.WriteJSON(w, http.StatusOK, map[string]string{"projectId": saved.ID})
	case "project.export":
		if !validProjectID(command.ProjectID) || (command.Format != "csv" && command.Format != "chapters") {
			return
		}
		project, err := s.config.Projects.Get(r.Context(), command.ProjectID)
		if err != nil {
			notFound(w, id)
			return
		}
		if project.Document, err = legacyProject(project.Document); err != nil {
			legacyProjectError(w, id)
			return
		}
		var data []byte
		if command.Format == "csv" {
			data, err = interchange.ExportCSV(project.Document)
		} else {
			data, err = interchange.ExportChapters(project.Document)
		}
		if err != nil {
			internalError(w, id)
			return
		}
		httpx.WriteJSON(w, http.StatusOK, map[string]string{"filename": "cutlist." + command.Format, "content": string(data)})
	case "job.status":
		if !validJobID(command.JobID) {
			return
		}
		job, err := s.config.Jobs.Get(r.Context(), command.JobID)
		if err != nil {
			notFound(w, id)
			return
		}
		httpx.WriteJSON(w, http.StatusOK, job)
	default:
		httpx.Error(w, http.StatusUnprocessableEntity, "unsupported_command", "Command is not supported.", id)
	}
}

func listenerLoopback(address string) bool {
	ip := net.ParseIP(address)
	return ip != nil && ip.IsLoopback()
}

func (s *Server) importInterchange(w http.ResponseWriter, r *http.Request, routeID, id string) {
	parts := strings.SplitN(routeID, ":", 2)
	if len(parts) != 2 {
		return
	}
	project, err := s.config.Projects.Get(r.Context(), parts[0])
	if err != nil {
		notFound(w, id)
		return
	}
	if project.Document, err = legacyProject(project.Document); err != nil {
		legacyProjectError(w, id)
		return
	}
	media, err := s.config.Media.Get(r.Context(), project.MediaID)
	if err != nil {
		notFound(w, id)
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, interchange.MaxInputBytes+1))
	if err != nil || len(body) > interchange.MaxInputBytes {
		httpx.Error(w, 422, "invalid_interchange", "Interchange input is invalid.", id)
		return
	}
	var segments []domain.Segment
	if parts[1] == "csv" {
		segments, err = interchange.ParseCSV(body, media.DurationMS)
	} else {
		segments, err = interchange.ParseChapters(body, media.DurationMS)
	}
	if err != nil {
		httpx.Error(w, 422, "invalid_interchange", "Interchange input is invalid.", id)
		return
	}
	project.Document, err = domain.ReplaceLegacySegments(project.Document, segments)
	if err != nil {
		legacyProjectError(w, id)
		return
	}
	saved, err := s.config.Projects.Save(r.Context(), parts[0], project.Document)
	if err != nil {
		httpx.Error(w, 409, "revision_conflict", "Project revision conflicts.", id)
		return
	}
	httpx.WriteJSON(w, 200, saved)
}
func (s *Server) exportInterchange(w http.ResponseWriter, r *http.Request, routeID, id string) {
	parts := strings.SplitN(routeID, ":", 2)
	if len(parts) != 2 {
		return
	}
	project, err := s.config.Projects.Get(r.Context(), parts[0])
	if err != nil {
		notFound(w, id)
		return
	}
	if project.Document, err = legacyProject(project.Document); err != nil {
		legacyProjectError(w, id)
		return
	}
	var data []byte
	if parts[1] == "csv" {
		data, err = interchange.ExportCSV(project.Document)
	} else {
		data, err = interchange.ExportChapters(project.Document)
	}
	if err != nil {
		internalError(w, id)
		return
	}
	if parts[1] == "csv" {
		w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	} else {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	}
	w.Header().Set("Content-Disposition", `attachment; filename="cutlist.`+parts[1]+`"`)
	w.WriteHeader(200)
	_, _ = w.Write(data)
}

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

func queryKeys(request *http.Request, allowed ...string) bool {
	if len(request.URL.RawQuery) > maxQueryBytes {
		return false
	}
	allowedSet := map[string]bool{}
	for _, key := range allowed {
		allowedSet[key] = true
	}
	for key, values := range request.URL.Query() {
		if !allowedSet[key] || len(values) != 1 {
			return false
		}
	}
	return true
}
func requiredInt(value string) (int64, error) {
	if value == "" {
		return 0, errors.New("missing")
	}
	return strconv.ParseInt(value, 10, 64)
}
func optionalInt(value string, fallback int64) (int64, error) {
	if value == "" {
		return fallback, nil
	}
	return strconv.ParseInt(value, 10, 64)
}
func assetNotModified(w http.ResponseWriter, r *http.Request, item Media, kind string) bool {
	sum := sha256.Sum256([]byte(kind + "\x00" + item.ETag + "\x00" + r.URL.RawQuery))
	etag := `"` + hex.EncodeToString(sum[:]) + `"`
	w.Header().Set("Cache-Control", "private, no-cache")
	w.Header().Set("ETag", etag)
	if r.Header.Get("If-None-Match") == etag {
		w.WriteHeader(http.StatusNotModified)
		return true
	}
	return false
}

func previewHeaders(writer http.ResponseWriter, spec PreviewSpec, cache string) {
	writer.Header().Set("X-Preview-Start", strconv.FormatInt(spec.StartMS, 10))
	writer.Header().Set("X-Preview-Duration", strconv.FormatInt(spec.WindowMS, 10))
	writer.Header().Set("X-Preview-Offset", strconv.FormatInt(spec.OffsetMS, 10))
	writer.Header().Set("X-Preview-Cache", cache)
}
func validExport(input ExportInput) bool {
	if (input.Mode != "merge" && input.Mode != "separate") || (input.Selection != "" && input.Selection != "segments" && input.Selection != "gaps") || (input.CutStrategy != "stream_copy_preferred" && input.CutStrategy != "precise_reencode" && input.CutStrategy != "hybrid_smart_cut") || input.Container != "mkv" {
		return false
	}
	if len(input.DestinationID) > 64 || len(input.FilenameTemplate) > 160 || strings.ContainsAny(input.DestinationID, "/\\") || strings.ContainsAny(input.FilenameTemplate, "\x00") {
		return false
	}
	seen := map[int]bool{}
	for _, index := range input.StreamIndexes {
		if index < 0 || seen[index] {
			return false
		}
		seen[index] = true
	}
	return true
}
func notFound(writer http.ResponseWriter, id string) {
	httpx.Error(writer, 404, "not_found", "Resource not found.", id)
}
func internalError(writer http.ResponseWriter, id string) {
	httpx.Error(writer, 500, "internal_error", "Request could not be completed.", id)
}
func routeFor(path string) string {
	if strings.HasPrefix(path, "/api/v1/") {
		return "/api/v1/unknown"
	}
	return path
}

type statusWriter struct {
	http.ResponseWriter
	status int
	wrote  bool
}

func (w *statusWriter) WriteHeader(status int) {
	if !w.wrote {
		w.status = status
		w.wrote = true
	}
	w.ResponseWriter.WriteHeader(status)
}
func (w *statusWriter) Write(data []byte) (int, error) {
	if !w.wrote {
		w.WriteHeader(http.StatusOK)
	}
	return w.ResponseWriter.Write(data)
}
func (w *statusWriter) Flush() {
	if flush, ok := w.ResponseWriter.(http.Flusher); ok {
		flush.Flush()
	}
}
