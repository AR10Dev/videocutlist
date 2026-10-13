// Package httpapi implements the v2 JSON control and native media contract without exposing media paths.
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
	"net/url"
	"os"
	"reflect"
	"strconv"
	"strings"
	"syscall"
	"time"
	"videocutlist/internal/detection"
	"videocutlist/internal/jobs/view"

	exporter "videocutlist/internal/export"
	"videocutlist/internal/exportpolicy"
	librarymedia "videocutlist/internal/library/media"
	"videocutlist/internal/mcp"
	"videocutlist/internal/preview"
	"videocutlist/internal/projects"
	"videocutlist/internal/projects/interchange"
	"videocutlist/internal/projects/model"
	settings "videocutlist/internal/settings"
	settingsmodel "videocutlist/internal/settings/model"

	"modernc.org/sqlite"
)

const (
	maxQueryBytes          = 4 << 10
	maxAutomationBodyBytes = interchange.MaxInputBytes
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
type ExportSubmissionInput struct {
	ProjectRevision int64    `json:"projectRevision"`
	ItemIDs         []string `json:"itemIds,omitempty"`
}

type PreviewSpec = preview.PreviewSpec
type PreviewResult = preview.PreviewResult
type AssetSpec = preview.AssetSpec
type AssetResult = preview.AssetResult

// The interfaces are intentionally API-shaped adapters. Concrete domain wiring
// remains outside this package, and no original path crosses this boundary.
type PreviewService = preview.PreviewService
type AssetService = preview.AssetService
type ProjectService = projects.ProjectService
type DetectionService interface {
	Submit(context.Context, string, string, detection.Request) (detection.Job, error)
}
type DestinationMetadata struct {
	ID          string `json:"id"`
	Label       string `json:"label"`
	Description string `json:"description,omitempty"`
	Kind        string `json:"kind"`
	Retention   string `json:"retention,omitempty"`
}

type DestinationCapabilities struct {
	SaveBesideSource bool `json:"saveBesideSource"`
}
type BatchExportService interface {
	Submit(context.Context, projects.BatchExportRequest) (string, []view.Job, error)
	Get(context.Context, string) (projects.Batch, error)
	List(context.Context, string, int) (projects.BatchPage, error)
	Retry(context.Context, string, string) (projects.Batch, error)
	Cancel(context.Context, string) error
}
type BatchDownloadService interface {
	DownloadBatch(context.Context, string) (io.ReadCloser, string, error)
}

type Config struct {
	Authenticator     Authenticator
	Media             librarymedia.MediaService
	MediaImport       librarymedia.MediaImportService
	Preview           PreviewService
	Assets            AssetService
	Projects          ProjectService
	BatchExports      BatchExportService
	Preflight         projects.ExportPreflightService
	Jobs              view.JobService
	Detection         DetectionService
	Download          exporter.ExportDownloadService
	BatchDownload     BatchDownloadService
	Settings          *settings.RuntimeService
	RuntimeSettings   *settingsmodel.RuntimeSettingsState
	MCPCredentials    *mcp.CredentialStore
	ExportProposals   *mcp.ProposalService
	SettingsAllowlist []string
	Destinations      []DestinationMetadata
	Ready             func(context.Context) error
	Logger            *log.Logger
	Metrics           *Metrics
	BeforeMS          int64
	AfterMS           int64
	MaxPreviewMS      int64
	GridMS            int64
	// ListenerAddress gates the local-only automation command surface.
	ListenerAddress       string
	AllowedOrigins        []string
	RequireAutomationAuth bool
}

// maxConcurrentObservations caps job and batch SSE handlers together per server.
const maxConcurrentObservations = 64

type Server struct {
	config           Config
	metrics          *Metrics
	shutdown         context.Context
	shutdownCancel   context.CancelFunc
	observationSlots chan struct{}
	routes           *http.ServeMux
	handler          http.Handler
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
	shutdown, shutdownCancel := context.WithCancel(context.Background())
	server := &Server{config: config, metrics: config.Metrics, shutdown: shutdown, shutdownCancel: shutdownCancel, observationSlots: make(chan struct{}, maxConcurrentObservations)}
	server.routes = newRouteMux(server)
	server.handler = CORS(config.AllowedOrigins, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		server.dispatch(w, r, RequestIDFromContext(r.Context()))
	}))
	return server, nil
}

// Shutdown stops long-lived observation handlers when the owning HTTP server shuts down.
func (s *Server) Shutdown() { s.shutdownCancel() }

func (s *Server) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	started := time.Now()
	id := RequestID()
	writer.Header().Set("X-Request-ID", id)
	request = request.WithContext(context.WithValue(request.Context(), requestIDKey{}, id))
	status := &statusWriter{ResponseWriter: writer, status: http.StatusOK, route: routeFor(request.URL.Path)}
	s.handler.ServeHTTP(status, request)
	route := status.route
	elapsed := time.Since(started)
	s.metrics.HTTP(route, request.Method, strconv.Itoa(status.status/100)+"xx", elapsed.Seconds())
	if s.config.Logger != nil {
		entry := map[string]any{"request_id": id, "method": request.Method, "route": route, "status": status.status, "duration_ms": float64(elapsed) / float64(time.Millisecond), "error_category": status.errorCode}
		if status.causeCategory != "" {
			entry["error_cause"] = status.causeCategory
			if status.causeType != "" {
				entry["error_type"] = status.causeType
			}
			if status.causeCode != nil {
				entry["error_cause_code"] = *status.causeCode
			}
		}
		if data, err := json.Marshal(entry); err == nil {
			s.config.Logger.Print(string(data))
		}
	}
}

func (s *Server) dispatch(writer http.ResponseWriter, request *http.Request, id string) {
	if request.URL.Path == "/health" && request.Method == http.MethodGet {
		if observed, ok := writer.(*statusWriter); ok {
			observed.route = "/health"
		}
		writer.WriteHeader(http.StatusOK)
		return
	}
	if request.URL.Path == "/ready" && request.Method == http.MethodGet {
		if observed, ok := writer.(*statusWriter); ok {
			observed.route = "/ready"
		}
		if s.config.Ready != nil {
			if err := s.config.Ready(request.Context()); err != nil {
				internalServerError(writer, http.StatusServiceUnavailable, "not_ready", "Service is not ready.", id, err)
				return
			}
		}
		writer.WriteHeader(http.StatusOK)
		return
	}
	if err := s.config.Authenticator.Authenticate(request); err != nil {
		Error(writer, http.StatusUnauthorized, "unauthenticated", "Authentication is required.", id)
		return
	}
	if request.URL.Path == "/metrics" && request.Method == http.MethodGet {
		writer.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
		if err := s.metrics.WritePrometheus(writer); err != nil {
			markInternalFailure(writer, err)
			if observed, ok := writer.(*statusWriter); ok {
				observed.errorCode = "metrics_write"
			}
			if s.config.Logger != nil {
				s.config.Logger.Print(`{"error_category":"metrics_write"}`)
			}
		}
		return
	}
	if !validRoutePath(request.URL.EscapedPath()) {
		notFound(writer, id)
		return
	}
	_, pattern := s.routes.Handler(request)
	if pattern == "" {
		notFound(writer, id)
		return
	}
	s.routes.ServeHTTP(writer, request)
}

func queryKeys(request *http.Request, allowed ...string) bool {
	if len(request.URL.RawQuery) > maxQueryBytes {
		return false
	}
	parsed, err := url.ParseQuery(request.URL.RawQuery)
	if err != nil {
		return false
	}
	allowedSet := map[string]bool{}
	for _, key := range allowed {
		allowedSet[key] = true
	}
	for key, values := range parsed {
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
func parseLimit(value string) (int, error) {
	if value == "" {
		return 50, nil
	}
	limit, err := strconv.Atoi(value)
	if err != nil || limit < 1 || limit > 100 {
		return 0, errors.New("invalid limit")
	}
	return limit, nil
}
func assetNotModified(w http.ResponseWriter, r *http.Request, item librarymedia.Media, kind string) bool {
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
	if (input.Mode != "merge" && input.Mode != "separate") || (input.Selection != "" && input.Selection != "segments" && input.Selection != "gaps") || (input.CutStrategy != "stream_copy_preferred" && input.CutStrategy != "precise_reencode" && input.CutStrategy != "hybrid_smart_cut") {
		return false
	}
	if _, ok := exportpolicy.For(input.Container); !ok {
		return false
	}
	if len(input.DestinationID) > 64 || len(input.FilenameTemplate) > 160 || strings.ContainsAny(input.DestinationID, "/\\") || strings.ContainsAny(input.FilenameTemplate, "\x00") || strings.IndexFunc(input.DestinationID, func(r rune) bool { return r < 32 || r == 127 }) >= 0 {
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
func internalError(writer http.ResponseWriter, id string, cause error) {
	markInternalFailure(writer, cause)
	httpx.Error(writer, 500, "internal_error", "Request could not be completed.", id)
}

func internalServerError(writer http.ResponseWriter, status int, code, message, id string, cause error) {
	markInternalFailure(writer, cause)
	httpx.Error(writer, status, code, message, id)
}

func markInternalFailure(writer http.ResponseWriter, cause error) {
	observed, ok := writer.(*statusWriter)
	if !ok {
		return
	}
	observed.causeCategory, observed.causeType, observed.causeCode = classifyInternalCause(cause)
}

// classifyInternalCause omits arbitrary error text so internal messages cannot leak secrets.
func classifyInternalCause(cause error) (category, typeName string, code *int) {
	if cause == nil {
		return "internal_failure", "", nil
	}
	if errors.Is(cause, context.Canceled) {
		return "context_canceled", "", nil
	}
	if errors.Is(cause, context.DeadlineExceeded) {
		return "context_deadline_exceeded", "", nil
	}
	if sqliteError, ok := errors.AsType[*sqlite.Error](cause); ok {
		return "sqlite", "", new(sqliteError.Code())
	}
	if _, ok := errors.AsType[*os.PathError](cause); ok {
		if errno, ok := errors.AsType[syscall.Errno](cause); ok {
			return "filesystem", "", new(int(errno))
		}
		return "filesystem", "", nil
	}
	if errno, ok := errors.AsType[syscall.Errno](cause); ok {
		return "os", "", new(int(errno))
	}
	return "unknown", reflect.TypeOf(cause).String(), nil
}
func routeFor(path string) string {
	switch {
	case path == "/metrics":
		return "/metrics"
	case path == "/api" || strings.HasPrefix(path, "/api/"):
		return "/api/v2/unknown"
	case path == "/media/v2" || strings.HasPrefix(path, "/media/v2/"):
		return "/media/v2/unknown"
	default:
		return "/unknown"
	}
}

type statusWriter struct {
	http.ResponseWriter
	status        int
	wrote         bool
	errorCode     string
	route         string
	causeCategory string
	causeType     string
	causeCode     *int
}

func (w *statusWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

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
	_ = w.FlushError()
}
func (w *statusWriter) FlushError() error {
	return http.NewResponseController(w.ResponseWriter).Flush()
}
