package api_test

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"videocutlist/application"
	auth "videocutlist/domain"
	api "videocutlist/protocol/http"
)

const validMedia = "m_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const validProject = "p_aaaaaaaaaaaa"

type mediaStub struct {
	calls, refreshCalls, importStarts int
	refreshErr, importErr             error
	status                            api.LibraryStatus
}

func (m *mediaStub) List(context.Context, string, int) (api.MediaPage, error) {
	return api.MediaPage{}, nil
}
func (m *mediaStub) Browse(context.Context, string, string, int) (api.FolderPage, error) {
	return api.FolderPage{}, nil
}
func (m *mediaStub) Get(context.Context, string) (api.Media, error) {
	m.calls++
	return api.Media{ID: validMedia, Name: "clip.mp4", DurationMS: 10_000, SizeBytes: 1, Container: "mp4", Streams: map[string]any{}, ETag: "e"}, nil
}
func (m *mediaStub) RefreshMedia(_ context.Context) error {
	m.refreshCalls++
	return m.refreshErr
}
func (m *mediaStub) Status() api.LibraryStatus { return m.status }
func (m *mediaStub) StartImport(context.Context) (application.ImportJob, error) {
	m.importStarts++
	if m.importErr != nil {
		return application.ImportJob{}, m.importErr
	}
	return application.ImportJob{ID: "j_scanresult1234", State: "queued"}, nil
}
func (m *mediaStub) ImportStatus(context.Context, string) (application.ImportJob, error) {
	return application.ImportJob{}, nil
}
func (m *mediaStub) CancelImport(context.Context, string) error { return nil }

type previewStub struct {
	start func(context.Context) (api.PreviewResult, error)
	calls int
}

func (p *previewStub) Start(ctx context.Context, _ api.PreviewSpec) (api.PreviewResult, error) {
	p.calls++
	return p.start(ctx)
}
func (p *previewStub) Cached(context.Context, api.PreviewSpec) (bool, error) { return false, nil }

type projectStub struct {
	get                 api.Project
	getCalls, saveCalls int
}

func (p *projectStub) Create(_ context.Context, id string, input auth.Document) (api.Project, error) {
	p.saveCalls++
	return api.Project{ID: id, Document: input}, nil
}
func (p *projectStub) Get(context.Context, string) (api.Project, error) {
	p.getCalls++
	return p.get, nil
}
func (p *projectStub) Save(_ context.Context, id string, input auth.Document) (api.Project, error) {
	p.saveCalls++
	return api.Project{ID: id, Document: input}, nil
}

type exportStub struct{ calls int }

func (e *exportStub) Create(context.Context, string, api.Project, api.ExportInput) (api.Job, error) {
	e.calls++
	return api.Job{ID: "j_aaaaaaaaaaaa", Type: "export", State: "queued"}, nil
}

type jobsStub struct {
	getCalls, cancelCalls int
	get                   func(context.Context, string) (api.Job, error)
}

type downloadStub struct {
	calls    int
	download func(context.Context, string, int) (io.ReadCloser, string, error)
}

func (d *downloadStub) Download(ctx context.Context, job string, position int) (io.ReadCloser, string, error) {
	d.calls++
	return d.download(ctx, job, position)
}

type headerAuthenticator struct{}

func (headerAuthenticator) Authenticate(*http.Request) error { return nil }

func (j *jobsStub) Get(ctx context.Context, id string) (api.Job, error) {
	j.getCalls++
	if j.get != nil {
		return j.get(ctx, id)
	}
	return api.Job{}, errors.New("missing")
}
func (j *jobsStub) Cancel(context.Context, string) error {
	j.cancelCalls++
	return errors.New("missing")
}

func server(t *testing.T, authenticator api.Authenticator, media *mediaStub, preview api.PreviewService, exports *exportStub) *api.Server {
	return serverWith(t, authenticator, media, preview, &projectStub{get: api.Project{ID: validProject}}, exports, &jobsStub{}, nil)
}

func serverWith(t *testing.T, authenticator api.Authenticator, media *mediaStub, preview api.PreviewService, projects api.ProjectService, exports *exportStub, jobs api.JobService, download application.ExportDownloadService) *api.Server {
	t.Helper()
	result, err := api.New(api.Config{Authenticator: authenticator, Media: media, MediaImport: media, Preview: preview, Projects: projects, Exports: exports, Jobs: jobs, Download: download})
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func noneAuth(t *testing.T) api.Authenticator {
	t.Helper()
	result, err := api.NewAuthenticator(api.AuthConfig{Mode: "none"})
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func TestUntrustedForwardedUserIsRejectedBeforeMedia(t *testing.T) {
	authenticator, err := api.NewAuthenticator(api.AuthConfig{Mode: "trusted_proxy"})
	if err != nil {
		t.Fatal(err)
	}
	media, exports := &mediaStub{}, &exportStub{}
	service := server(t, authenticator, media, &previewStub{start: func(context.Context) (api.PreviewResult, error) { return api.PreviewResult{}, nil }}, exports)
	request := httptest.NewRequest(http.MethodGet, "/api/v1/media/"+validMedia, nil)
	request.RemoteAddr = "10.0.0.4:1234"
	request.Header.Set("X-Forwarded-User", "spoof@example.com")
	request.Header.Set("Tailscale-User-Login", "spoof@example.com")
	recorder := httptest.NewRecorder()
	service.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusUnauthorized || media.calls != 0 {
		t.Fatalf("status=%d media calls=%d", recorder.Code, media.calls)
	}
	if !strings.Contains(recorder.Body.String(), `"requestId"`) {
		t.Fatalf("missing safe request id: %s", recorder.Body.String())
	}
}

func TestAPIAuthenticationModesRejectBeforeServices(t *testing.T) {
	for _, test := range []struct {
		name       string
		config     api.AuthConfig
		authorize  string
		wantStatus int
	}{
		{name: "none ignores bearer", config: api.AuthConfig{Mode: "none"}, authorize: "Bearer ignored", wantStatus: http.StatusOK},
		{name: "correct bearer with internal space", config: api.AuthConfig{Mode: "bearer", BearerToken: "alpha beta"}, authorize: "Bearer alpha beta", wantStatus: http.StatusOK},
		{name: "missing bearer", config: api.AuthConfig{Mode: "bearer", BearerToken: "alpha beta"}, wantStatus: http.StatusUnauthorized},
		{name: "missing bearer suffix", config: api.AuthConfig{Mode: "bearer", BearerToken: "alpha beta"}, authorize: "Bearer", wantStatus: http.StatusUnauthorized},
		{name: "wrong bearer", config: api.AuthConfig{Mode: "bearer", BearerToken: "alpha beta"}, authorize: "Bearer alpha gamma", wantStatus: http.StatusUnauthorized},
		{name: "malformed scheme", config: api.AuthConfig{Mode: "bearer", BearerToken: "alpha beta"}, authorize: "Basic alpha beta", wantStatus: http.StatusUnauthorized},
		{name: "multiple bearer", config: api.AuthConfig{Mode: "bearer", BearerToken: "alpha beta"}, wantStatus: http.StatusUnauthorized},
	} {
		t.Run(test.name, func(t *testing.T) {
			authenticator, err := api.NewAuthenticator(test.config)
			if err != nil {
				t.Fatal(err)
			}
			media, exports := &mediaStub{}, &exportStub{}
			service := server(t, authenticator, media, &previewStub{start: func(context.Context) (api.PreviewResult, error) { return api.PreviewResult{}, nil }}, exports)
			request := localRequest(http.MethodGet, "/api/v1/media/"+validMedia, nil)
			if test.name == "multiple bearer" {
				request.Header.Add("Authorization", "Bearer secret")
				request.Header.Add("Authorization", "Bearer secret")
			} else if test.authorize != "" {
				request.Header.Set("Authorization", test.authorize)
			}
			response := httptest.NewRecorder()
			service.ServeHTTP(response, request)
			if response.Code != test.wantStatus || test.wantStatus == http.StatusUnauthorized && media.calls != 0 {
				t.Fatalf("status=%d media calls=%d", response.Code, media.calls)
			}
		})
	}
}

func TestTrustedProxyAccessGateReachesPreview(t *testing.T) {
	authenticator, err := api.NewAuthenticator(api.AuthConfig{Mode: "trusted_proxy"})
	if err != nil {
		t.Fatal(err)
	}
	media, exports := &mediaStub{}, &exportStub{}
	preview := &previewStub{start: func(context.Context) (api.PreviewResult, error) {
		return api.PreviewResult{Reader: io.NopCloser(strings.NewReader("preview")), CacheStatus: "hit", DurationMS: 8_000}, nil
	}}
	service := server(t, authenticator, media, preview, exports)
	handler, err := api.TrustedProxy([]string{"127.0.0.0/8"}, service)
	if err != nil {
		t.Fatal(err)
	}
	request := localRequest(http.MethodGet, "/api/v1/media/"+validMedia+"/preview?centerMs=100", nil)
	request.Header.Set("X-Forwarded-User", "proxy-editor")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || preview.calls != 1 {
		t.Fatalf("status=%d preview calls=%d", response.Code, preview.calls)
	}
}

func TestInvalidIDsAndOversizeBodiesDoNotReachServices(t *testing.T) {
	media, exports := &mediaStub{}, &exportStub{}
	service := server(t, noneAuth(t), media, &previewStub{start: func(context.Context) (api.PreviewResult, error) { return api.PreviewResult{}, nil }}, exports)
	for _, target := range []string{"/api/v1/media/../../etc/passwd", "/api/v1/media/m_not-an-id", "/api/v1/media/" + strings.Repeat("a", 1000)} {
		recorder := httptest.NewRecorder()
		service.ServeHTTP(recorder, localRequest(http.MethodGet, target, nil))
		if recorder.Code != http.StatusNotFound {
			t.Fatalf("%s: status=%d", target, recorder.Code)
		}
	}
	request := localRequest(http.MethodPut, "/api/v1/projects/"+validProject, strings.NewReader(strings.Repeat("x", 1<<20+1)))
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	service.ServeHTTP(recorder, request)
	if recorder.Code != 422 || media.calls != 0 {
		t.Fatalf("oversize status=%d media calls=%d", recorder.Code, media.calls)
	}
	request = localRequest(http.MethodPut, "/api/v1/projects/"+validProject, strings.NewReader(`{"mediaId":"`+validMedia+`","revision":0,"uiState":{"playheadMs":0,"zoom":1,"muted":false}}`))
	request.Header.Set("Content-Type", "application/json")
	recorder = httptest.NewRecorder()
	service.ServeHTTP(recorder, request)
	if recorder.Code != 422 || media.calls != 0 {
		t.Fatalf("missing field status=%d media calls=%d", recorder.Code, media.calls)
	}
}

func TestDownloadOutputLifecycle(t *testing.T) {
	const job = "j_aaaaaaaaaaaa"
	const internalPath = "/var/lib/videocutlist/exports/secret.mkv"
	stub := &downloadStub{download: func(_ context.Context, gotJob string, position int) (io.ReadCloser, string, error) {
		if gotJob != job {
			return nil, "", errors.New("missing")
		}
		switch position {
		case 0:
			return io.NopCloser(strings.NewReader("video bytes")), "export.mkv", nil
		case 1:
			return nil, "", errors.New("expired")
		case 2:
			return nil, "", errors.New("cancelled")
		case 3:
			return nil, "", errors.New("archive destination")
		case 4:
			return io.NopCloser(strings.NewReader("secret")), internalPath, nil
		default:
			return nil, "", errors.New("missing")
		}
	}}
	service := serverWith(t, headerAuthenticator{}, &mediaStub{}, &previewStub{start: func(context.Context) (api.PreviewResult, error) { return api.PreviewResult{}, nil }}, &projectStub{get: api.Project{ID: validProject}}, &exportStub{}, &jobsStub{}, stub)

	request := func(position string) *http.Request {
		return localRequest(http.MethodGet, "/api/v1/jobs/"+job+"/outputs/"+position, nil)
	}

	response := httptest.NewRecorder()
	service.ServeHTTP(response, request("0"))
	if response.Code != http.StatusOK || response.Body.String() != "video bytes" || response.Header().Get("Content-Type") != "video/x-matroska" || response.Header().Get("Content-Disposition") != `attachment; filename="export.mkv"` {
		t.Fatalf("successful download status=%d headers=%v body=%q", response.Code, response.Header(), response.Body.String())
	}

	for _, test := range []struct {
		name, position string
		status         int
	}{
		{"unknown output", "9", http.StatusNotFound},
		{"negative output", "-1", http.StatusNotFound},
		{"out of range output", "100", http.StatusNotFound},
		{"non-numeric output", "nope", http.StatusNotFound},
		{"traversal-shaped output", "%2e%2e", http.StatusNotFound},
		{"expired export", "1", http.StatusNotFound},
		{"cancelled export", "2", http.StatusNotFound},
		{"non-download destination", "3", http.StatusNotFound},
		{"unsafe returned name", "4", http.StatusNotFound},
	} {
		t.Run(test.name, func(t *testing.T) {
			response := httptest.NewRecorder()
			service.ServeHTTP(response, request(test.position))
			if response.Code != test.status || strings.Contains(response.Body.String(), internalPath) || response.Header().Get("Content-Disposition") != "" {
				t.Fatalf("status=%d headers=%v body=%q", response.Code, response.Header(), response.Body.String())
			}
		})
	}
}

func TestLibraryStatusContractIsSafe(t *testing.T) {
	for _, want := range []api.LibraryStatus{
		{State: api.LibraryUnconfigured, Message: "No media library is configured."},
		{State: api.LibraryScanning, Message: "Scanning media library."},
		{State: api.LibraryReadyEmpty, Message: "No supported media was found."},
		{State: api.LibraryReadyWithMedia, Message: "Media library is ready."},
		{State: api.LibraryFailed, Message: "Media library scan failed. Try refreshing it."},
	} {
		service := server(t, noneAuth(t), &mediaStub{status: want}, &previewStub{start: func(context.Context) (api.PreviewResult, error) { return api.PreviewResult{}, nil }}, &exportStub{})
		response := httptest.NewRecorder()
		service.ServeHTTP(response, localRequest(http.MethodGet, "/api/v1/media/status", nil))
		if response.Code != http.StatusOK || strings.Contains(response.Body.String(), "/private/media") {
			t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
		}
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(response.Body.Bytes(), &fields); err != nil || len(fields) != 2 || fields["state"] == nil || fields["message"] == nil {
			t.Fatalf("response fields=%v err=%v body=%s", fields, err, response.Body.String())
		}
	}
}

func TestRefreshReturnsAcceptedUnifiedJobAndPropagatesSubmissionFailure(t *testing.T) {
	media := &mediaStub{}
	service := server(t, noneAuth(t), media, &previewStub{start: func(context.Context) (api.PreviewResult, error) { return api.PreviewResult{}, nil }}, &exportStub{})
	response := httptest.NewRecorder()
	service.ServeHTTP(response, localRequest(http.MethodPost, "/api/v1/media/refresh", nil))
	var job application.ImportJob
	if err := json.Unmarshal(response.Body.Bytes(), &job); err != nil {
		t.Fatal(err)
	}
	if response.Code != http.StatusAccepted || media.importStarts != 1 || job.ID != "j_scanresult1234" || job.State != "queued" {
		t.Fatalf("status=%d starts=%d job=%#v body=%s", response.Code, media.importStarts, job, response.Body.String())
	}
	media.importErr = errors.New("submission failed")
	response = httptest.NewRecorder()
	service.ServeHTTP(response, localRequest(http.MethodPost, "/api/v1/media/refresh", nil))
	if response.Code != http.StatusInternalServerError || media.importStarts != 2 {
		t.Fatalf("failure status=%d starts=%d", response.Code, media.importStarts)
	}
}

func TestJobResponsesExposeOnlySafeTerminalMetadata(t *testing.T) {
	retainUntil := time.Date(2026, 8, 20, 12, 0, 0, 0, time.UTC)
	code := "media_unavailable"
	jobs := &jobsStub{get: func(_ context.Context, _ string) (api.Job, error) {
		return api.Job{ID: "j_aaaaaaaaaaaa", Type: "export", State: "succeeded", Progress: 1, Result: &application.JobResult{OutputName: "export.mkv", SizeBytes: 42, RetainUntil: retainUntil}, Warnings: []string{"Cut may start at an earlier keyframe."}}, nil
	}}
	service := serverWith(t, headerAuthenticator{}, &mediaStub{}, &previewStub{start: func(context.Context) (api.PreviewResult, error) { return api.PreviewResult{}, nil }}, &projectStub{get: api.Project{ID: validProject}}, &exportStub{}, jobs, nil)
	response := httptest.NewRecorder()
	request := localRequest(http.MethodGet, "/api/v1/jobs/j_aaaaaaaaaaaa", nil)
	service.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("succeeded status=%d body=%s", response.Code, response.Body.String())
	}
	for _, forbidden := range []string{"outputDir", "stderr", "errorCode", "/exports"} {
		if strings.Contains(response.Body.String(), forbidden) {
			t.Fatalf("succeeded response exposed %q: %s", forbidden, response.Body.String())
		}
	}
	if !strings.Contains(response.Body.String(), `"result":{"outputName":"export.mkv","sizeBytes":42,"retainUntil":"2026-08-20T12:00:00Z"}`) {
		t.Fatalf("missing safe result: %s", response.Body.String())
	}

	jobs.get = func(context.Context, string) (api.Job, error) {
		return api.Job{ID: "j_aaaaaaaaaaaa", Type: "export", State: "failed", Progress: 1, ErrorCode: &code}, nil
	}
	response = httptest.NewRecorder()
	request = localRequest(http.MethodGet, "/api/v1/jobs/j_aaaaaaaaaaaa", nil)
	service.ServeHTTP(response, request)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"errorCode":"media_unavailable"`) || strings.Contains(response.Body.String(), `"result"`) || strings.Contains(response.Body.String(), `"warnings"`) {
		t.Fatalf("failed response=%d %s", response.Code, response.Body.String())
	}

	jobs.get = func(_ context.Context, _ string) (api.Job, error) {
		return api.Job{ID: "j_aaaaaaaaaaaa", Type: "export", State: "queued"}, nil
	}
	request = localRequest(http.MethodGet, "/api/v1/jobs/j_aaaaaaaaaaaa", nil)
	request.Header.Set("X-Test-User", "other")
	response = httptest.NewRecorder()
	service.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("job status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestPreviewCancellationUsesRequestContextAndFailureIsSafe(t *testing.T) {
	media, exports := &mediaStub{}, &exportStub{}
	started := make(chan struct{})
	var once sync.Once
	preview := &previewStub{start: func(ctx context.Context) (api.PreviewResult, error) {
		once.Do(func() { close(started) })
		return api.PreviewResult{Reader: &contextReader{ctx: ctx}, CacheStatus: "miss", DurationMS: 8_000}, nil
	}}
	service := server(t, noneAuth(t), media, preview, exports)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	request := localRequest(http.MethodGet, "/api/v1/media/"+validMedia+"/preview?centerMs=100", nil).WithContext(ctx)
	recorder := httptest.NewRecorder()
	done := make(chan struct{})
	go func() { service.ServeHTTP(recorder, request); close(done) }()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("preview did not start")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("request cancellation did not detach preview")
	}
	if recorder.Code != http.StatusOK {
		t.Fatalf("status=%d", recorder.Code)
	}

	failing := server(t, noneAuth(t), &mediaStub{}, &previewStub{start: func(context.Context) (api.PreviewResult, error) {
		return api.PreviewResult{}, errors.New("ffmpeg stderr /originals/secret.mp4 /cache/preview.mp4 /exports/final.mkv provider=tailnet")
	}}, &exportStub{})
	recorder = httptest.NewRecorder()
	failing.ServeHTTP(recorder, localRequest(http.MethodGet, "/api/v1/media/"+validMedia+"/preview?centerMs=100", nil))
	if recorder.Code != http.StatusTooManyRequests {
		t.Fatalf("unsafe failure: %d %s", recorder.Code, recorder.Body.String())
	}
	for _, forbidden := range []string{"stderr", "/originals", "/cache", "/exports", "provider", "tailnet"} {
		if strings.Contains(recorder.Body.String(), forbidden) {
			t.Fatalf("unsafe failure exposed %q: %s", forbidden, recorder.Body.String())
		}
	}
}

type contextReader struct{ ctx context.Context }

func (r *contextReader) Read([]byte) (int, error) { <-r.ctx.Done(); return 0, r.ctx.Err() }
func (r *contextReader) Close() error             { return nil }

var _ io.ReadCloser = (*contextReader)(nil)

func localRequest(method, target string, body io.Reader) *http.Request {
	request := httptest.NewRequest(method, target, body)
	request.RemoteAddr = "127.0.0.1:1234"
	return request
}
