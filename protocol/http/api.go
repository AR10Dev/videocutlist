// Package httpapi implements the frozen v1 HTTP contract without exposing media paths.
package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"videocutlist/application"
	"videocutlist/domain"
	"videocutlist/infrastructure/interchange"
)

const (
	maxQueryBytes          = 4 << 10
	maxAutomationBodyBytes = interchange.MaxInputBytes
)

type Media = application.Media
type MediaPage = application.MediaPage
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
type JobService = application.JobService
type DetectionRequest = application.DetectionRequest
type DetectionJob = application.DetectionJob
type DetectionService interface {
	Create(context.Context, domain.Principal, string, DetectionRequest) (DetectionJob, error)
	Get(context.Context, domain.Principal, string) (DetectionJob, error)
	Cancel(context.Context, domain.Principal, string) error
}
type Authorizer interface {
	Allow(domain.Principal, string, string) bool
}
type AuthorizerFunc func(domain.Principal, string, string) bool

func (f AuthorizerFunc) Allow(principal domain.Principal, action, resource string) bool {
	return f(principal, action, resource)
}

type Config struct {
	Authenticator Authenticator
	Media         MediaService
	Preview       PreviewService
	Assets        AssetService
	Projects      ProjectService
	Exports       ExportService
	Jobs          JobService
	Detection     DetectionService
	Authorize     Authorizer
	Ready         func(context.Context) error
	Logger        *log.Logger
	Metrics       *Metrics
	BeforeMS      int64
	AfterMS       int64
	MaxPreviewMS  int64
	GridMS        int64
	// ListenerAddress gates the local-only automation command surface.
	ListenerAddress       string
	RequireAutomationAuth bool
}

type Server struct {
	config  Config
	metrics *Metrics
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
	route, subject := s.dispatch(status, request, id)
	s.metrics.HTTP(route, request.Method, strconv.Itoa(status.status/100)+"xx", time.Since(started).Seconds())
	if s.config.Logger != nil {
		data, _ := json.Marshal(map[string]any{"request_id": id, "principal_subject": subject, "method": request.Method, "route": route, "status": status.status})
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
	principal, ok := s.identity(writer, request, id)
	if !ok {
		return routeFor(request.URL.Path), ""
	}
	r := parseRoute(request.Method, request.URL.EscapedPath())
	switch r.kind {
	case routeListMedia:
		s.listMedia(writer, request, id)
		return "/api/v1/media", principal.Subject
	case routeRefreshMedia:
		s.refreshMedia(writer, request, principal, id)
		return "/api/v1/media/refresh", principal.Subject
	case routeGetMedia:
		s.getMedia(writer, request, r.id, id)
		return "/api/v1/media/{mediaId}", principal.Subject
	case routePreview:
		s.preview(writer, request, principal, r.id, id)
		return "/api/v1/media/{mediaId}/preview", principal.Subject
	case routeThumbnails:
		s.thumbnails(writer, request, principal, r.id, id)
		return "/api/v1/media/{mediaId}/thumbnails", principal.Subject
	case routeWaveform:
		s.waveform(writer, request, principal, r.id, id)
		return "/api/v1/media/{mediaId}/waveform", principal.Subject
	case routeGetProject:
		s.getProject(writer, request, principal, r.id, id)
		return "/api/v1/projects/{projectId}", principal.Subject
	case routePutProject:
		s.putProject(writer, request, principal, r.id, id)
		return "/api/v1/projects/{projectId}", principal.Subject
	case routeCreateExport:
		s.createExport(writer, request, principal, r.id, id)
		return "/api/v1/projects/{projectId}/exports", principal.Subject
	case routeImportInterchange:
		s.importInterchange(writer, request, principal, r.id, id)
		return "/api/v1/projects/{projectId}/interchange/{format}", principal.Subject
	case routeExportInterchange:
		s.exportInterchange(writer, request, principal, r.id, id)
		return "/api/v1/projects/{projectId}/interchange/{format}", principal.Subject
	case routeCreateDetection:
		s.createDetection(writer, request, principal, r.id, id)
		return "/api/v1/projects/{projectId}/detections", principal.Subject
	case routeGetJob:
		s.getJob(writer, request, principal, r.id, id)
		return "/api/v1/jobs/{jobId}", principal.Subject
	case routeCancelJob:
		s.cancelJob(writer, request, principal, r.id, id)
		return "/api/v1/jobs/{jobId}", principal.Subject
	case routeAutomation:
		s.automation(writer, request, principal, id)
		return "/api/v1/automation", principal.Subject
	}
	httpx.Error(writer, http.StatusNotFound, "not_found", "Resource not found.", id)
	return routeFor(request.URL.Path), principal.Subject
}

func (s *Server) identity(writer http.ResponseWriter, request *http.Request, id string) (domain.Principal, bool) {
	principal, err := s.config.Authenticator.Authenticate(request)
	if err != nil {
		Error(writer, http.StatusUnauthorized, "unauthenticated", "Authentication is required.", id)
		return domain.Principal{}, false
	}
	return principal, true
}
func (s *Server) allowed(writer http.ResponseWriter, principal domain.Principal, action, resource, id string) bool {
	if (s.config.Authorize == nil && principal.Allows(action, resource)) || s.config.Authorize != nil && s.config.Authorize.Allow(principal, action, resource) {
		return true
	}
	Error(writer, http.StatusForbidden, "forbidden", "Permission denied.", id)
	return false
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

func (s *Server) refreshMedia(writer http.ResponseWriter, request *http.Request, principal domain.Principal, id string) {
	if !s.allowed(writer, principal, "media_refresh", "*", id) {
		return
	}
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

func (s *Server) preview(writer http.ResponseWriter, request *http.Request, principal domain.Principal, media string, id string) {
	if !s.allowed(writer, principal, "preview", media, id) {
		return
	}
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
	result, err := s.config.Preview.Start(request.Context(), principal, spec)
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

func (s *Server) thumbnails(w http.ResponseWriter, r *http.Request, p domain.Principal, media, id string) {
	if s.config.Assets == nil || !s.allowed(w, p, "media_assets", media, id) {
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
	result, err := s.config.Assets.Thumbnails(r.Context(), p, spec)
	if err != nil {
		internalError(w, id)
		return
	}
	defer result.Reader.Close()
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "private, no-cache")
	w.WriteHeader(http.StatusOK)
	_, _ = io.Copy(w, result.Reader)
}

func (s *Server) waveform(w http.ResponseWriter, r *http.Request, p domain.Principal, media, id string) {
	if s.config.Assets == nil || !s.allowed(w, p, "media_assets", media, id) {
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
	result, err := s.config.Assets.Waveform(r.Context(), p, spec)
	if errors.Is(err, application.ErrNoAudio) {
		httpx.Error(w, 422, "no_audio", "Media has no audio stream.", id)
		return
	}
	if err != nil {
		internalError(w, id)
		return
	}
	w.Header().Set("Cache-Control", "private, no-cache")
	httpx.WriteJSON(w, 200, map[string]any{"startMs": result.StartMS, "durationMs": result.DurationMS, "peaks": result.Peaks})
}

func (s *Server) previewSpec(request *http.Request, item Media) (PreviewSpec, error) {
	if !queryKeys(request, "centerMs", "beforeMs", "afterMs", "mute") {
		return PreviewSpec{}, errors.New("unknown query")
	}
	query := request.URL.Query()
	center, err := requiredInt(query.Get("centerMs"))
	if err != nil || center < 0 {
		return PreviewSpec{}, errors.New("center")
	}
	before, err := optionalInt(query.Get("beforeMs"), s.config.BeforeMS)
	if err != nil || before < 0 {
		return PreviewSpec{}, errors.New("before")
	}
	after, err := optionalInt(query.Get("afterMs"), s.config.AfterMS)
	if err != nil || after < 0 || before+after > s.config.MaxPreviewMS {
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
	return application.NormalizePreview(item.ID, item.DurationMS, center, mute, domain.WindowConfig{BeforeMS: before, AfterMS: after, MaxMS: s.config.MaxPreviewMS, GridMS: s.config.GridMS})
}

func (s *Server) getProject(writer http.ResponseWriter, request *http.Request, principal domain.Principal, project string, id string) {
	if !s.allowed(writer, principal, "project_read", project, id) {
		return
	}
	value, err := s.config.Projects.Get(request.Context(), principal, project)
	if err != nil {
		notFound(writer, id)
		return
	}
	httpx.WriteJSON(writer, 200, value)
}
func (s *Server) putProject(writer http.ResponseWriter, request *http.Request, principal domain.Principal, project string, id string) {
	if !s.allowed(writer, principal, "project_save", project, id) {
		return
	}
	var input ProjectInput
	if httpx.ReadJSON(request, &input) != nil {
		httpx.Error(writer, 422, "invalid_project", "Project is invalid.", id)
		return
	}
	if !validMediaID(input.MediaID) {
		httpx.Error(writer, 422, "invalid_project", "Project is invalid.", id)
		return
	}
	media, err := s.config.Media.Get(request.Context(), input.MediaID)
	if err != nil {
		httpx.Error(writer, 422, "invalid_project", "Project is invalid.", id)
		return
	}
	saved, err := s.config.Projects.Save(request.Context(), principal, project, domain.Document(input), media.DurationMS)
	if err != nil {
		httpx.Error(writer, http.StatusConflict, "revision_conflict", "Project revision conflicts.", id)
		return
	}
	httpx.WriteJSON(writer, 200, saved)
}
func (s *Server) createExport(writer http.ResponseWriter, request *http.Request, principal domain.Principal, project string, id string) {
	if !s.allowed(writer, principal, "export", project, id) {
		return
	}
	owned, err := s.config.Projects.Get(request.Context(), principal, project)
	if err != nil {
		notFound(writer, id)
		return
	}
	var input ExportInput
	if httpx.ReadJSON(request, &input) != nil || !validExport(input) {
		httpx.Error(writer, 422, "invalid_export", "Export is invalid.", id)
		return
	}
	job, err := s.config.Exports.Create(request.Context(), principal, project, owned, input)
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
func (s *Server) createDetection(writer http.ResponseWriter, request *http.Request, principal domain.Principal, project string, id string) {
	if s.config.Detection == nil || !s.allowed(writer, principal, "detect", project, id) {
		if s.config.Detection == nil {
			internalError(writer, id)
		}
		return
	}
	owned, err := s.config.Projects.Get(request.Context(), principal, project)
	if err != nil {
		notFound(writer, id)
		return
	}
	var input DetectionRequest
	if httpx.ReadJSON(request, &input) != nil || input.MediaID != owned.MediaID || input.ProjectRevision != owned.Revision || !input.Kind.Valid() {
		httpx.Error(writer, http.StatusConflict, "stale_project", "Detection request is stale.", id)
		return
	}
	job, err := s.config.Detection.Create(request.Context(), principal, project, input)
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

func (s *Server) automation(w http.ResponseWriter, r *http.Request, p domain.Principal, id string) {
	if r.Header.Get("Origin") != "" || !listenerLoopback(s.config.ListenerAddress) || !s.config.RequireAutomationAuth || p.Subject == "" || p.Subject == "anonymous" {
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
		if !validProjectID(command.ProjectID) || (command.Format != "csv" && command.Format != "chapters") || command.Input == "" || !s.allowed(w, p, "project_import", command.ProjectID, id) {
			return
		}
		// Reuse the canonical HTTP interchange path and return only its opaque project ID.
		project, err := s.config.Projects.Get(r.Context(), p, command.ProjectID)
		if err != nil {
			notFound(w, id)
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
		project.Segments = segments
		saved, err := s.config.Projects.Save(r.Context(), p, command.ProjectID, project.Document, media.DurationMS)
		if err != nil {
			httpx.Error(w, http.StatusConflict, "revision_conflict", "Project revision conflicts.", id)
			return
		}
		httpx.WriteJSON(w, http.StatusOK, map[string]string{"projectId": saved.ID})
	case "project.export":
		if !validProjectID(command.ProjectID) || (command.Format != "csv" && command.Format != "chapters") || !s.allowed(w, p, "project_export", command.ProjectID, id) {
			return
		}
		project, err := s.config.Projects.Get(r.Context(), p, command.ProjectID)
		if err != nil {
			notFound(w, id)
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
		if !validJobID(command.JobID) || !s.allowed(w, p, "job_read", command.JobID, id) {
			return
		}
		job, err := s.config.Jobs.Get(r.Context(), p, command.JobID)
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

func (s *Server) importInterchange(w http.ResponseWriter, r *http.Request, p domain.Principal, routeID, id string) {
	parts := strings.SplitN(routeID, ":", 2)
	if len(parts) != 2 || !s.allowed(w, p, "project_import", parts[0], id) {
		return
	}
	project, err := s.config.Projects.Get(r.Context(), p, parts[0])
	if err != nil {
		notFound(w, id)
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
	project.Segments = segments
	saved, err := s.config.Projects.Save(r.Context(), p, parts[0], project.Document, media.DurationMS)
	if err != nil {
		httpx.Error(w, 409, "revision_conflict", "Project revision conflicts.", id)
		return
	}
	httpx.WriteJSON(w, 200, saved)
}
func (s *Server) exportInterchange(w http.ResponseWriter, r *http.Request, p domain.Principal, routeID, id string) {
	parts := strings.SplitN(routeID, ":", 2)
	if len(parts) != 2 || !s.allowed(w, p, "project_export", parts[0], id) {
		return
	}
	project, err := s.config.Projects.Get(r.Context(), p, parts[0])
	if err != nil {
		notFound(w, id)
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

func (s *Server) getJob(writer http.ResponseWriter, request *http.Request, principal domain.Principal, job string, id string) {
	if !s.allowed(writer, principal, "job_read", job, id) {
		return
	}
	if s.config.Detection != nil {
		if value, err := s.config.Detection.Get(request.Context(), principal, job); err == nil {
			httpx.WriteJSON(writer, 200, value)
			return
		}
	}
	if s.config.Jobs == nil {
		notFound(writer, id)
		return
	}
	value, err := s.config.Jobs.Get(request.Context(), principal, job)
	if err != nil {
		notFound(writer, id)
		return
	}
	httpx.WriteJSON(writer, 200, value)
}
func (s *Server) cancelJob(writer http.ResponseWriter, request *http.Request, principal domain.Principal, job string, id string) {
	if !s.allowed(writer, principal, "job_cancel", job, id) {
		return
	}
	if s.config.Detection != nil {
		if _, err := s.config.Detection.Get(request.Context(), principal, job); err == nil {
			if err := s.config.Detection.Cancel(request.Context(), principal, job); err != nil {
				notFound(writer, id)
				return
			}
			writer.WriteHeader(http.StatusNoContent)
			return
		}
	}
	if s.config.Jobs == nil {
		notFound(writer, id)
		return
	}
	if err := s.config.Jobs.Cancel(request.Context(), principal, job); err != nil {
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
