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

	"editapp/internal/api"
	"editapp/internal/auth"
)

const validMedia = "m_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const validProject = "p_aaaaaaaaaaaa"

type mediaStub struct{ calls int }

func (m *mediaStub) List(context.Context, string, int) (api.MediaPage, error) {
	return api.MediaPage{}, nil
}
func (m *mediaStub) Get(context.Context, string) (api.Media, error) {
	m.calls++
	return api.Media{ID: validMedia, Name: "clip.mp4", DurationMS: 10_000, SizeBytes: 1, Container: "mp4", Streams: map[string]any{}, ETag: "e"}, nil
}
func (m *mediaStub) Refresh(context.Context) (api.Job, error) { return api.Job{}, nil }

type previewStub struct {
	start func(context.Context) (api.PreviewResult, error)
}

func (p previewStub) Start(ctx context.Context, _ string, _ api.PreviewSpec) (api.PreviewResult, error) {
	return p.start(ctx)
}
func (p previewStub) Cached(context.Context, api.PreviewSpec) (bool, error) { return false, nil }

type projectStub struct{ get api.Project }

func (p projectStub) Get(context.Context, string, string) (api.Project, error) { return p.get, nil }
func (p projectStub) Save(_ context.Context, _ string, id string, input api.ProjectInput, _ int64) (api.Project, error) {
	return api.Project{ID: id, ProjectInput: input}, nil
}

type exportStub struct{ calls int }

func (e *exportStub) Create(context.Context, string, string, api.Project, api.ExportInput) (api.Job, error) {
	e.calls++
	return api.Job{ID: "j_aaaaaaaaaaaa", Type: "export", State: "queued"}, nil
}

type jobsStub struct{}

func (jobsStub) Get(context.Context, string, string) (api.Job, error) {
	return api.Job{}, errors.New("missing")
}
func (jobsStub) Cancel(context.Context, string, string) error { return errors.New("missing") }

func server(t *testing.T, authenticator *auth.Authenticator, media *mediaStub, preview api.PreviewService, exports *exportStub, authorize api.Authorizer) *api.Server {
	t.Helper()
	result, err := api.New(api.Config{Authenticator: authenticator, Media: media, Preview: preview, Projects: projectStub{get: api.Project{ID: validProject}}, Exports: exports, Jobs: jobsStub{}, Authorize: authorize})
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func devAuth(t *testing.T) *auth.Authenticator {
	t.Helper()
	result, err := auth.New(auth.Config{Mode: "dev", DevUserLogin: "editor@example.com"})
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func TestSpoofedTailscaleHeadersAreRejectedBeforeMedia(t *testing.T) {
	authenticator, err := auth.New(auth.Config{Mode: "tailscale", TrustedProxyCIDRs: []string{"127.0.0.0/8"}})
	if err != nil {
		t.Fatal(err)
	}
	media, exports := &mediaStub{}, &exportStub{}
	service := server(t, authenticator, media, previewStub{start: func(context.Context) (api.PreviewResult, error) { return api.PreviewResult{}, nil }}, exports, nil)
	request := httptest.NewRequest(http.MethodGet, "/api/v1/media/"+validMedia, nil)
	request.RemoteAddr = "10.0.0.4:1234"
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

func TestInvalidIDsAndOversizeBodiesDoNotReachServices(t *testing.T) {
	media, exports := &mediaStub{}, &exportStub{}
	service := server(t, devAuth(t), media, previewStub{start: func(context.Context) (api.PreviewResult, error) { return api.PreviewResult{}, nil }}, exports, nil)
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
	service := server(t, devAuth(t), media, previewStub{start: func(context.Context) (api.PreviewResult, error) { return api.PreviewResult{}, nil }}, exports, api.AuthorizerFunc(func(auth.Identity, string, string) bool { return false }))
	request := localRequest(http.MethodPost, "/api/v1/projects/"+validProject+"/exports", strings.NewReader(`{"mode":"merge","cutStrategy":"stream_copy_preferred","container":"mkv"}`))
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	service.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusForbidden || exports.calls != 0 {
		t.Fatalf("status=%d export calls=%d", recorder.Code, exports.calls)
	}
}

func TestPreviewCancellationUsesRequestContextAndFailureIsSafe(t *testing.T) {
	media, exports := &mediaStub{}, &exportStub{}
	started := make(chan struct{})
	var once sync.Once
	preview := previewStub{start: func(ctx context.Context) (api.PreviewResult, error) {
		once.Do(func() { close(started) })
		return api.PreviewResult{Reader: &contextReader{ctx: ctx}, CacheStatus: "miss", DurationMS: 8_000}, nil
	}}
	service := server(t, devAuth(t), media, preview, exports, nil)
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

	failing := server(t, devAuth(t), &mediaStub{}, previewStub{start: func(context.Context) (api.PreviewResult, error) {
		return api.PreviewResult{}, errors.New("ffmpeg stderr secret")
	}}, &exportStub{}, nil)
	recorder = httptest.NewRecorder()
	failing.ServeHTTP(recorder, localRequest(http.MethodGet, "/api/v1/media/"+validMedia+"/preview?centerMs=100", nil))
	if recorder.Code != http.StatusTooManyRequests || strings.Contains(recorder.Body.String(), "stderr") {
		t.Fatalf("unsafe failure: %d %s", recorder.Code, recorder.Body.String())
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
