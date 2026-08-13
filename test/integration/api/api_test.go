package api_test

import (
	"context"
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
	calls, refreshCalls int
	refreshJob          api.Job
	refreshErr          error
}

func (m *mediaStub) List(context.Context, string, int) (api.MediaPage, error) {
	return api.MediaPage{}, nil
}
func (m *mediaStub) Get(context.Context, string) (api.Media, error) {
	m.calls++
	return api.Media{ID: validMedia, Name: "clip.mp4", DurationMS: 10_000, SizeBytes: 1, Container: "mp4", Streams: map[string]any{}, ETag: "e"}, nil
}
func (m *mediaStub) RefreshMedia(_ context.Context, _ auth.Principal) (api.Job, error) {
	m.refreshCalls++
	return m.refreshJob, m.refreshErr
}

type previewStub struct {
	start     func(context.Context) (api.PreviewResult, error)
	calls     int
	principal auth.Principal
}

func (p *previewStub) Start(ctx context.Context, principal auth.Principal, _ api.PreviewSpec) (api.PreviewResult, error) {
	p.calls++
	p.principal = principal
	return p.start(ctx)
}
func (p *previewStub) Cached(context.Context, api.PreviewSpec) (bool, error) { return false, nil }

type projectStub struct {
	get                 api.Project
	getCalls, saveCalls int
}

func (p *projectStub) Get(context.Context, auth.Principal, string) (api.Project, error) {
	p.getCalls++
	return p.get, nil
}
func (p *projectStub) Save(_ context.Context, _ auth.Principal, id string, input auth.Document, _ int64) (api.Project, error) {
	p.saveCalls++
	return api.Project{ID: id, Document: input}, nil
}

type exportStub struct{ calls int }

func (e *exportStub) Create(context.Context, auth.Principal, string, api.Project, api.ExportInput) (api.Job, error) {
	e.calls++
	return api.Job{ID: "j_aaaaaaaaaaaa", Type: "export", State: "queued"}, nil
}

type jobsStub struct {
	getCalls, cancelCalls int
	get                   func(context.Context, auth.Principal, string) (api.Job, error)
}

type headerAuthenticator struct{}

func (headerAuthenticator) Authenticate(request *http.Request) (auth.Principal, error) {
	return auth.Principal{Subject: request.Header.Get("X-Test-User"), Capabilities: []string{"job_read"}}, nil
}

func (j *jobsStub) Get(ctx context.Context, principal auth.Principal, id string) (api.Job, error) {
	j.getCalls++
	if j.get != nil {
		return j.get(ctx, principal, id)
	}
	return api.Job{}, errors.New("missing")
}
func (j *jobsStub) Cancel(context.Context, auth.Principal, string) error {
	j.cancelCalls++
	return errors.New("missing")
}

func server(t *testing.T, authenticator api.Authenticator, media *mediaStub, preview api.PreviewService, exports *exportStub, authorize api.Authorizer) *api.Server {
	return serverWith(t, authenticator, media, preview, &projectStub{get: api.Project{ID: validProject}}, exports, &jobsStub{}, authorize)
}

func serverWith(t *testing.T, authenticator api.Authenticator, media *mediaStub, preview api.PreviewService, projects api.ProjectService, exports *exportStub, jobs api.JobService, authorize api.Authorizer) *api.Server {
	t.Helper()
	result, err := api.New(api.Config{Authenticator: authenticator, Media: media, Preview: preview, Projects: projects, Exports: exports, Jobs: jobs, Authorize: authorize})
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
	service := server(t, authenticator, media, &previewStub{start: func(context.Context) (api.PreviewResult, error) { return api.PreviewResult{}, nil }}, exports, nil)
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
			service := server(t, authenticator, media, &previewStub{start: func(context.Context) (api.PreviewResult, error) { return api.PreviewResult{}, nil }}, exports, nil)
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

func TestTrustedProxyPrincipalReachesPreview(t *testing.T) {
	authenticator, err := api.NewAuthenticator(api.AuthConfig{Mode: "trusted_proxy"})
	if err != nil {
		t.Fatal(err)
	}
	media, exports := &mediaStub{}, &exportStub{}
	preview := &previewStub{start: func(context.Context) (api.PreviewResult, error) {
		return api.PreviewResult{Reader: io.NopCloser(strings.NewReader("preview")), CacheStatus: "hit", DurationMS: 8_000}, nil
	}}
	service := server(t, authenticator, media, preview, exports, nil)
	handler, err := api.TrustedProxy([]string{"127.0.0.0/8"}, service)
	if err != nil {
		t.Fatal(err)
	}
	request := localRequest(http.MethodGet, "/api/v1/media/"+validMedia+"/preview?centerMs=100", nil)
	request.Header.Set("X-Forwarded-User", "proxy-editor")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || preview.calls != 1 || preview.principal.Subject != "proxy-editor" {
		t.Fatalf("status=%d preview calls=%d principal=%#v", response.Code, preview.calls, preview.principal)
	}
}

func TestInvalidIDsAndOversizeBodiesDoNotReachServices(t *testing.T) {
	media, exports := &mediaStub{}, &exportStub{}
	service := server(t, noneAuth(t), media, &previewStub{start: func(context.Context) (api.PreviewResult, error) { return api.PreviewResult{}, nil }}, exports, nil)
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

func TestUnauthorizedExportNeverQueuesWork(t *testing.T) {
	media, exports := &mediaStub{}, &exportStub{}
	service := server(t, noneAuth(t), media, &previewStub{start: func(context.Context) (api.PreviewResult, error) { return api.PreviewResult{}, nil }}, exports, api.AuthorizerFunc(func(auth.Principal, string, string) bool { return false }))
	request := localRequest(http.MethodPost, "/api/v1/projects/"+validProject+"/exports", strings.NewReader(`{"mode":"merge","cutStrategy":"stream_copy_preferred","container":"mkv"}`))
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	service.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusForbidden || exports.calls != 0 {
		t.Fatalf("status=%d export calls=%d", recorder.Code, exports.calls)
	}
}

func TestRefreshReturnsCompletedJobAndBusyRemainsRetryable(t *testing.T) {
	media := &mediaStub{refreshJob: api.Job{ID: "j_aaaaaaaaaaaa", Type: "media_refresh", State: "succeeded", Progress: 1}}
	service := server(t, noneAuth(t), media, &previewStub{start: func(context.Context) (api.PreviewResult, error) { return api.PreviewResult{}, nil }}, &exportStub{}, nil)
	response := httptest.NewRecorder()
	service.ServeHTTP(response, localRequest(http.MethodPost, "/api/v1/media/refresh", nil))
	if response.Code != http.StatusOK || media.refreshCalls != 1 || !strings.Contains(response.Body.String(), `"state":"succeeded"`) {
		t.Fatalf("status=%d calls=%d body=%s", response.Code, media.refreshCalls, response.Body.String())
	}
	media.refreshErr = application.ErrBusy
	response = httptest.NewRecorder()
	service.ServeHTTP(response, localRequest(http.MethodPost, "/api/v1/media/refresh", nil))
	if response.Code != http.StatusTooManyRequests || media.refreshCalls != 2 {
		t.Fatalf("busy status=%d calls=%d", response.Code, media.refreshCalls)
	}
}

func TestForbiddenRequestsDoNotInvokePrincipalBoundServices(t *testing.T) {
	media, exports, projects, jobs := &mediaStub{}, &exportStub{}, &projectStub{get: api.Project{ID: validProject}}, &jobsStub{}
	preview := &previewStub{start: func(context.Context) (api.PreviewResult, error) { return api.PreviewResult{}, nil }}
	service := serverWith(t, noneAuth(t), media, preview, projects, exports, jobs, api.AuthorizerFunc(func(auth.Principal, string, string) bool { return false }))
	for name, request := range map[string]*http.Request{
		"refresh":      localRequest(http.MethodPost, "/api/v1/media/refresh", nil),
		"preview":      localRequest(http.MethodGet, "/api/v1/media/"+validMedia+"/preview?centerMs=100", nil),
		"project read": localRequest(http.MethodGet, "/api/v1/projects/"+validProject, nil),
		"project save": localRequest(http.MethodPut, "/api/v1/projects/"+validProject, strings.NewReader(`{"mediaId":"`+validMedia+`","revision":0,"segments":[],"uiState":{"playheadMs":0,"zoom":1,"muted":false}}`)),
		"export":       localRequest(http.MethodPost, "/api/v1/projects/"+validProject+"/exports", strings.NewReader(`{"mode":"merge","cutStrategy":"stream_copy_preferred","container":"mkv"}`)),
		"job read":     localRequest(http.MethodGet, "/api/v1/jobs/j_aaaaaaaaaaaa", nil),
		"job cancel":   localRequest(http.MethodDelete, "/api/v1/jobs/j_aaaaaaaaaaaa", nil),
	} {
		t.Run(name, func(t *testing.T) {
			response := httptest.NewRecorder()
			service.ServeHTTP(response, request)
			if response.Code != http.StatusForbidden {
				t.Fatalf("status=%d", response.Code)
			}
		})
	}
	if media.refreshCalls != 0 || preview.calls != 0 || projects.getCalls != 0 || projects.saveCalls != 0 || exports.calls != 0 || jobs.getCalls != 0 || jobs.cancelCalls != 0 {
		t.Fatalf("service calls: media=%d preview=%d projects=(%d,%d) exports=%d jobs=(%d,%d)", media.refreshCalls, preview.calls, projects.getCalls, projects.saveCalls, exports.calls, jobs.getCalls, jobs.cancelCalls)
	}
}

func TestJobResponsesExposeOnlySafeTerminalMetadata(t *testing.T) {
	retainUntil := time.Date(2026, 8, 20, 12, 0, 0, 0, time.UTC)
	code := "media_unavailable"
	jobs := &jobsStub{get: func(_ context.Context, principal auth.Principal, _ string) (api.Job, error) {
		if principal.Subject == "other" {
			return api.Job{}, errors.New("missing")
		}
		return api.Job{ID: "j_aaaaaaaaaaaa", Type: "export", State: "succeeded", Progress: 1, Result: &application.JobResult{OutputName: "export.mkv", SizeBytes: 42, RetainUntil: retainUntil}, Warnings: []string{"Cut may start at an earlier keyframe."}}, nil
	}}
	service := serverWith(t, headerAuthenticator{}, &mediaStub{}, &previewStub{start: func(context.Context) (api.PreviewResult, error) { return api.PreviewResult{}, nil }}, &projectStub{get: api.Project{ID: validProject}}, &exportStub{}, jobs, nil)
	response := httptest.NewRecorder()
	request := localRequest(http.MethodGet, "/api/v1/jobs/j_aaaaaaaaaaaa", nil)
	request.Header.Set("X-Test-User", "owner")
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

	jobs.get = func(context.Context, auth.Principal, string) (api.Job, error) {
		return api.Job{ID: "j_aaaaaaaaaaaa", Type: "export", State: "failed", Progress: 1, ErrorCode: &code}, nil
	}
	response = httptest.NewRecorder()
	request = localRequest(http.MethodGet, "/api/v1/jobs/j_aaaaaaaaaaaa", nil)
	request.Header.Set("X-Test-User", "owner")
	service.ServeHTTP(response, request)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"errorCode":"media_unavailable"`) || strings.Contains(response.Body.String(), `"result"`) || strings.Contains(response.Body.String(), `"warnings"`) {
		t.Fatalf("failed response=%d %s", response.Code, response.Body.String())
	}

	jobs.get = func(_ context.Context, principal auth.Principal, _ string) (api.Job, error) {
		if principal.Subject != "owner" {
			return api.Job{}, errors.New("missing")
		}
		return api.Job{ID: "j_aaaaaaaaaaaa", Type: "export", State: "queued"}, nil
	}
	request = localRequest(http.MethodGet, "/api/v1/jobs/j_aaaaaaaaaaaa", nil)
	request.Header.Set("X-Test-User", "other")
	response = httptest.NewRecorder()
	service.ServeHTTP(response, request)
	if response.Code != http.StatusNotFound {
		t.Fatalf("cross-owner status=%d body=%s", response.Code, response.Body.String())
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
	service := server(t, noneAuth(t), media, preview, exports, nil)
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
	}}, &exportStub{}, nil)
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
