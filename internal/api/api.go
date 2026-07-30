// Package api implements the frozen v1 HTTP contract without exposing media paths.
package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"editapp/internal/auth"
	"editapp/internal/httpx"
	"editapp/internal/metrics"
)

var (
	mediaID   = regexp.MustCompile(`^m_[A-Za-z0-9_-]{43}$`)
	projectID = regexp.MustCompile(`^p_[A-Za-z0-9_-]{12,64}$`)
	jobID     = regexp.MustCompile(`^j_[A-Za-z0-9_-]{12,64}$`)
)

const maxQueryBytes = 4 << 10

var ErrBusy = errors.New("service is busy")

type Media struct {
	ID         string         `json:"id"`
	Name       string         `json:"name"`
	DurationMS int64          `json:"durationMs"`
	SizeBytes  int64          `json:"sizeBytes"`
	Container  string         `json:"container"`
	Streams    map[string]any `json:"streams"`
	ETag       string         `json:"etag"`
}

type MediaPage struct {
	Items      []Media `json:"items"`
	NextCursor *string `json:"nextCursor"`
}

type Segment struct {
	StartMS int64  `json:"startMs"`
	EndMS   int64  `json:"endMs"`
	Label   string `json:"label,omitempty"`
}
type UIState struct {
	PlayheadMS int64   `json:"playheadMs"`
	Zoom       float64 `json:"zoom"`
	Muted      bool    `json:"muted"`
}
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

type Project struct {
	ProjectInput
	ID        string    `json:"id"`
	UpdatedAt time.Time `json:"updatedAt"`
}
type ExportInput struct {
	Mode                  string `json:"mode"`
	CutStrategy           string `json:"cutStrategy"`
	Container             string `json:"container"`
	SmartBoundaryReencode *bool  `json:"smartBoundaryReencode,omitempty"`
}
type Job struct {
	ID        string    `json:"id"`
	Type      string    `json:"type"`
	State     string    `json:"state"`
	Progress  float64   `json:"progress"`
	Warnings  []string  `json:"warnings,omitempty"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

type PreviewSpec struct {
	MediaID                                 string
	DurationMS, StartMS, WindowMS, OffsetMS int64
	Mute                                    bool
}
type PreviewResult struct {
	Reader                        io.ReadCloser
	CacheStatus                   string
	StartMS, DurationMS, OffsetMS int64
}

// The interfaces are intentionally API-shaped adapters. Concrete domain wiring
// remains outside this package, and no original path crosses this boundary.
type MediaService interface {
	List(context.Context, string, int) (MediaPage, error)
	Get(context.Context, string) (Media, error)
	RefreshMedia(context.Context, string) (Job, error)
}
type PreviewService interface {
	Start(context.Context, string, PreviewSpec) (PreviewResult, error)
	Cached(context.Context, PreviewSpec) (bool, error)
}
type ProjectService interface {
	Get(context.Context, string, string) (Project, error)
	Save(context.Context, string, string, ProjectInput, int64) (Project, error)
}
type ExportService interface {
	Create(context.Context, string, string, Project, ExportInput) (Job, error)
}
type JobService interface {
	Get(context.Context, string, string) (Job, error)
	Cancel(context.Context, string, string) error
}
type Authorizer interface {
	Allow(auth.Identity, string, string) bool
}
type AuthorizerFunc func(auth.Identity, string, string) bool

func (f AuthorizerFunc) Allow(identity auth.Identity, action, resource string) bool {
	return f(identity, action, resource)
}

type Config struct {
	Authenticator *auth.Authenticator
	Media         MediaService
	Preview       PreviewService
	Projects      ProjectService
	Exports       ExportService
	Jobs          JobService
	Authorize     Authorizer
	Ready         func(context.Context) error
	Logger        *log.Logger
	Metrics       *metrics.Metrics
	BeforeMS      int64
	AfterMS       int64
	MaxPreviewMS  int64
	GridMS        int64
}

type Server struct {
	config  Config
	metrics *metrics.Metrics
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
		config.Metrics = metrics.New()
	}
	return &Server{config: config, metrics: config.Metrics}, nil
}

func (s *Server) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	started := time.Now()
	id := httpx.RequestID()
	writer.Header().Set("X-Request-ID", id)
	status := &statusWriter{ResponseWriter: writer, status: http.StatusOK}
	route, login := s.dispatch(status, request, id)
	s.metrics.HTTP(route, request.Method, strconv.Itoa(status.status/100)+"xx", time.Since(started).Seconds())
	if s.config.Logger != nil {
		data, _ := json.Marshal(map[string]any{"request_id": id, "user_login": login, "method": request.Method, "route": route, "status": status.status})
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
			httpx.Error(writer, http.StatusServiceUnavailable, "not_ready", "Service is not ready.", id)
		} else {
			writer.WriteHeader(http.StatusOK)
		}
		return "/api/v1/ready", ""
	}
	identity, ok := s.identity(writer, request, id)
	if !ok {
		return routeFor(request.URL.Path), ""
	}
	path := strings.TrimPrefix(request.URL.Path, "/api/v1")
	switch {
	case path == "/media" && request.Method == http.MethodGet:
		s.listMedia(writer, request, id)
		return "/api/v1/media", identity.Login
	case path == "/media/refresh" && request.Method == http.MethodPost:
		s.refreshMedia(writer, request, identity, id)
		return "/api/v1/media/refresh", identity.Login
	case path == "/media" && request.Method != http.MethodGet:
		break
	case strings.HasPrefix(path, "/media/"):
		parts := strings.Split(strings.TrimPrefix(path, "/media/"), "/")
		if len(parts) == 1 && request.Method == http.MethodGet {
			s.getMedia(writer, request, parts[0], id)
			return "/api/v1/media/{mediaId}", identity.Login
		}
		if len(parts) == 2 && parts[1] == "preview" && (request.Method == http.MethodGet || request.Method == http.MethodHead) {
			s.preview(writer, request, identity, parts[0], id)
			return "/api/v1/media/{mediaId}/preview", identity.Login
		}
	case strings.HasPrefix(path, "/projects/"):
		parts := strings.Split(strings.TrimPrefix(path, "/projects/"), "/")
		if len(parts) == 1 && request.Method == http.MethodGet {
			s.getProject(writer, request, identity, parts[0], id)
			return "/api/v1/projects/{projectId}", identity.Login
		}
		if len(parts) == 1 && request.Method == http.MethodPut {
			s.putProject(writer, request, identity, parts[0], id)
			return "/api/v1/projects/{projectId}", identity.Login
		}
		if len(parts) == 2 && parts[1] == "exports" && request.Method == http.MethodPost {
			s.createExport(writer, request, identity, parts[0], id)
			return "/api/v1/projects/{projectId}/exports", identity.Login
		}
	case strings.HasPrefix(path, "/jobs/"):
		parts := strings.Split(strings.TrimPrefix(path, "/jobs/"), "/")
		if len(parts) == 1 && request.Method == http.MethodGet {
			s.getJob(writer, request, identity, parts[0], id)
			return "/api/v1/jobs/{jobId}", identity.Login
		}
		if len(parts) == 1 && request.Method == http.MethodDelete {
			s.cancelJob(writer, request, identity, parts[0], id)
			return "/api/v1/jobs/{jobId}", identity.Login
		}
	}
	httpx.Error(writer, http.StatusNotFound, "not_found", "Resource not found.", id)
	return routeFor(request.URL.Path), identity.Login
}

func (s *Server) identity(writer http.ResponseWriter, request *http.Request, id string) (auth.Identity, bool) {
	identity, err := s.config.Authenticator.Authenticate(request)
	if err != nil {
		httpx.Error(writer, http.StatusUnauthorized, "unauthenticated", "Authentication is required.", id)
		return auth.Identity{}, false
	}
	return identity, true
}
func (s *Server) allowed(writer http.ResponseWriter, identity auth.Identity, action, resource, id string) bool {
	if s.config.Authorize == nil || s.config.Authorize.Allow(identity, action, resource) {
		return true
	}
	httpx.Error(writer, http.StatusForbidden, "forbidden", "Permission denied.", id)
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
	if len(cursor) > 128 || cursor != "" && !mediaID.MatchString(cursor) {
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

func (s *Server) refreshMedia(writer http.ResponseWriter, request *http.Request, identity auth.Identity, id string) {
	if !s.allowed(writer, identity, "media_refresh", "*", id) {
		return
	}
	job, err := s.config.Media.RefreshMedia(request.Context(), identity.Login)
	if err != nil {
		if errors.Is(err, ErrBusy) {
			httpx.Error(writer, http.StatusTooManyRequests, "refresh_busy", "A media refresh is already in progress.", id)
			return
		}
		internalError(writer, id)
		return
	}
	httpx.WriteJSON(writer, http.StatusAccepted, job)
}
func (s *Server) getMedia(writer http.ResponseWriter, request *http.Request, media string, id string) {
	if !mediaID.MatchString(media) {
		notFound(writer, id)
		return
	}
	result, err := s.config.Media.Get(request.Context(), media)
	if err != nil {
		notFound(writer, id)
		return
	}
	httpx.WriteJSON(writer, 200, result)
}

func (s *Server) preview(writer http.ResponseWriter, request *http.Request, identity auth.Identity, media string, id string) {
	if !mediaID.MatchString(media) {
		notFound(writer, id)
		return
	}
	if !s.allowed(writer, identity, "preview", media, id) {
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
	result, err := s.config.Preview.Start(request.Context(), identity.Login, spec)
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
	if center > item.DurationMS {
		center = item.DurationMS
	}
	grid := center / s.config.GridMS * s.config.GridMS
	duration := before + after
	if duration > item.DurationMS {
		duration = item.DurationMS
	}
	start := grid - before
	if start < 0 {
		start = 0
	}
	if start+duration > item.DurationMS {
		start = item.DurationMS - duration
	}
	offset := center - start
	if offset < 0 {
		start = center
		offset = 0
	}
	if offset > duration {
		start = center - duration
		offset = duration
	}
	return PreviewSpec{MediaID: item.ID, DurationMS: item.DurationMS, StartMS: start, WindowMS: duration, OffsetMS: offset, Mute: mute}, nil
}

func (s *Server) getProject(writer http.ResponseWriter, request *http.Request, identity auth.Identity, project string, id string) {
	if !projectID.MatchString(project) {
		notFound(writer, id)
		return
	}
	value, err := s.config.Projects.Get(request.Context(), identity.Login, project)
	if err != nil {
		notFound(writer, id)
		return
	}
	httpx.WriteJSON(writer, 200, value)
}
func (s *Server) putProject(writer http.ResponseWriter, request *http.Request, identity auth.Identity, project string, id string) {
	if !projectID.MatchString(project) {
		notFound(writer, id)
		return
	}
	var input ProjectInput
	if httpx.ReadJSON(request, &input) != nil {
		httpx.Error(writer, 422, "invalid_project", "Project is invalid.", id)
		return
	}
	if !mediaID.MatchString(input.MediaID) {
		httpx.Error(writer, 422, "invalid_project", "Project is invalid.", id)
		return
	}
	media, err := s.config.Media.Get(request.Context(), input.MediaID)
	if err != nil {
		httpx.Error(writer, 422, "invalid_project", "Project is invalid.", id)
		return
	}
	if !validProject(input, media.DurationMS) {
		httpx.Error(writer, 422, "invalid_project", "Project is invalid.", id)
		return
	}
	saved, err := s.config.Projects.Save(request.Context(), identity.Login, project, input, media.DurationMS)
	if err != nil {
		httpx.Error(writer, http.StatusConflict, "revision_conflict", "Project revision conflicts.", id)
		return
	}
	httpx.WriteJSON(writer, 200, saved)
}
func (s *Server) createExport(writer http.ResponseWriter, request *http.Request, identity auth.Identity, project string, id string) {
	if !projectID.MatchString(project) {
		notFound(writer, id)
		return
	}
	owned, err := s.config.Projects.Get(request.Context(), identity.Login, project)
	if err != nil {
		notFound(writer, id)
		return
	}
	if !s.allowed(writer, identity, "export", project, id) {
		return
	}
	var input ExportInput
	if httpx.ReadJSON(request, &input) != nil || !validExport(input) {
		httpx.Error(writer, 422, "invalid_export", "Export is invalid.", id)
		return
	}
	job, err := s.config.Exports.Create(request.Context(), identity.Login, project, owned, input)
	if err != nil {
		if errors.Is(err, ErrBusy) {
			httpx.Error(writer, http.StatusTooManyRequests, "export_busy", "Export capacity is full.", id)
			return
		}
		internalError(writer, id)
		return
	}
	s.metrics.Add("export_jobs_total", 1)
	httpx.WriteJSON(writer, http.StatusAccepted, job)
}
func (s *Server) getJob(writer http.ResponseWriter, request *http.Request, identity auth.Identity, job string, id string) {
	if !jobID.MatchString(job) {
		notFound(writer, id)
		return
	}
	value, err := s.config.Jobs.Get(request.Context(), identity.Login, job)
	if err != nil {
		notFound(writer, id)
		return
	}
	httpx.WriteJSON(writer, 200, value)
}
func (s *Server) cancelJob(writer http.ResponseWriter, request *http.Request, identity auth.Identity, job string, id string) {
	if !jobID.MatchString(job) {
		notFound(writer, id)
		return
	}
	if err := s.config.Jobs.Cancel(request.Context(), identity.Login, job); err != nil {
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
func validProject(input ProjectInput, duration int64) bool {
	if input.Revision < 0 || input.UIState.PlayheadMS < 0 || input.UIState.PlayheadMS > duration || input.UIState.Zoom <= 0 {
		return false
	}
	previous := int64(0)
	for i, segment := range input.Segments {
		if segment.StartMS < 0 || segment.EndMS <= segment.StartMS || segment.EndMS > duration || len([]rune(segment.Label)) > 200 || i > 0 && segment.StartMS < previous {
			return false
		}
		previous = segment.EndMS
	}
	return true
}
func validExport(input ExportInput) bool {
	return input.Mode == "merge" && input.CutStrategy == "stream_copy_preferred" && input.Container == "mkv" && (input.SmartBoundaryReencode == nil || !*input.SmartBoundaryReencode)
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
