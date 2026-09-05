// Package httpapi implements the frozen v1 HTTP contract without exposing media paths.
package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"videocutlist/internal/db"
	jobqueue "videocutlist/internal/jobs"
	"videocutlist/internal/projects"
	"videocutlist/internal/projects/interchange"
	"videocutlist/internal/projects/model"
)

const (
	maxQueryBytes          = 4 << 10
	maxAutomationBodyBytes = interchange.MaxInputBytes
)

type Media = projects.Media
type MediaPage = projects.MediaPage
type FolderPage = projects.FolderPage
type LibraryStatus = projects.LibraryStatus
type LibraryState = projects.LibraryState

const (
	LibraryUnconfigured   = projects.LibraryUnconfigured
	LibraryScanning       = projects.LibraryScanning
	LibraryReadyEmpty     = projects.LibraryReadyEmpty
	LibraryReadyWithMedia = projects.LibraryReadyWithMedia
	LibraryFailed         = projects.LibraryFailed
)

type Segment = model.Segment
type UIState = model.UIState
type ProjectInput struct {
	Revision      int64               `json:"revision"`
	SchemaVersion int                 `json:"schemaVersion"`
	Name          string              `json:"name"`
	Items         []model.ProjectItem `json:"items"`
}

func (p *ProjectInput) UnmarshalJSON(data []byte) error {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return err
	}
	for _, key := range []string{"revision", "schemaVersion", "name", "items"} {
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

func (p ProjectInput) input() projects.ProjectInput {
	return projects.ProjectInput{Revision: p.Revision, Document: model.Document{SchemaVersion: p.SchemaVersion, Name: p.Name, Items: p.Items}}
}

type Project = projects.Project
type ExportInput = projects.ExportInput

type Job = projects.Job
type PreviewSpec = projects.PreviewSpec
type PreviewResult = projects.PreviewResult
type AssetSpec = projects.AssetSpec
type AssetResult = projects.AssetResult

// The interfaces are intentionally API-shaped adapters. Concrete domain wiring
// remains outside this package, and no original path crosses this boundary.
type MediaService = projects.MediaService
type PreviewService = projects.PreviewService
type AssetService = projects.AssetService
type ProjectService = projects.ProjectService
type ExportPreflightService = projects.ExportPreflightService
type JobService = projects.JobService
type DetectionRequest = projects.DetectionRequest
type DetectionJob = projects.DetectionJob
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
	Submit(context.Context, projects.BatchExportRequest) (string, []projects.Job, error)
	Progress(context.Context, string) (jobqueue.JobState, float64, error)
	Get(context.Context, string) (projects.Batch, error)
	List(context.Context, int) (projects.BatchPage, error)
	Retry(context.Context, string) (projects.Batch, error)
	Cancel(context.Context, string) error
}
type BatchDownloadService interface {
	DownloadBatch(context.Context, string) (io.ReadCloser, string, error)
}

type Config struct {
	Authenticator        Authenticator
	Media                MediaService
	MediaImport          projects.MediaImportService
	Preview              PreviewService
	Assets               AssetService
	Projects             ProjectService
	BatchExports         BatchExportService
	Preflight            ExportPreflightService
	Jobs                 JobService
	Detection            DetectionService
	Download             projects.ExportDownloadService
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
	if config.Authenticator == nil || config.Media == nil || config.Preview == nil || config.Projects == nil || config.BatchExports == nil || config.Jobs == nil {
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
	case routeListProjects:
		s.listProjects(writer, request, id)
		return "/api/v1/projects", ""
	case routeGetProject:
		s.getProject(writer, request, r.id, id)
		return "/api/v1/projects/{projectId}", ""
	case routePutProject:
		s.putProject(writer, request, r.id, id)
		return "/api/v1/projects/{projectId}", ""
	case routeCreateExport:
		s.createExport(writer, request, r.id, id)
		return "/api/v1/projects/{projectId}/exports", ""
	case routeListBatches:
		s.listBatches(writer, request, id)
		return "/api/v1/batches", ""
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
	case routeDownloadBatch:
		s.downloadBatch(writer, request, r.id, id)
		return "/api/v1/batches/{batchId}/download", ""
	case routeCancelJob:
		s.cancelJob(writer, request, r.id, id)
		return "/api/v1/jobs/{jobId}", ""
	case routeRetryJob:
		s.retryJob(writer, request, r.id, id)
		return "/api/v1/jobs/{jobId}/retry", ""
	case routeAutomation:
		s.automation(writer, request, id)
		return "/api/v1/automation", ""
	}
	httpx.Error(writer, http.StatusNotFound, "not_found", "Resource not found.", id)
	return routeFor(request.URL.Path), ""
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
