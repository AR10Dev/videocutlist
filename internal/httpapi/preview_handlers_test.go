package httpapi

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"videocutlist/internal/library/media/index"
	"videocutlist/internal/projects"
)

type previewErrorService struct {
	startErr  error
	cachedErr error
	cached    bool
}

func (s previewErrorService) Start(context.Context, PreviewSpec) (PreviewResult, error) {
	return PreviewResult{}, s.startErr
}

func (s previewErrorService) Cached(context.Context, PreviewSpec) (bool, error) {
	return s.cached, s.cachedErr
}

type previewHandlerMedia struct {
	item Media
}

func (m previewHandlerMedia) List(context.Context, string, int) (MediaPage, error) {
	return MediaPage{}, nil
}

func (m previewHandlerMedia) Browse(context.Context, string, string, int) (FolderPage, error) {
	return FolderPage{}, nil
}

func (m previewHandlerMedia) Get(context.Context, string) (Media, error) {
	return m.item, nil
}

func (m previewHandlerMedia) RefreshMedia(context.Context) error { return nil }
func (m previewHandlerMedia) Status() LibraryStatus              { return LibraryStatus{} }

func newPreviewErrorServer(t *testing.T, preview PreviewService) *Server {
	t.Helper()
	authenticator, err := NewAuthenticator(AuthConfig{Mode: "none"})
	if err != nil {
		t.Fatal(err)
	}
	mediaID := "m_" + strings.Repeat("a", 43)
	server, err := New(Config{
		Authenticator: authenticator,
		Media:         previewHandlerMedia{item: Media{ID: mediaID, DurationMS: 1_000}},
		Preview:       preview,
		Projects:      routeTestProjects{},
		BatchExports:  &routeTestBatchExports{},
		Jobs:          &routeTestJobs{},
	})
	if err != nil {
		t.Fatal(err)
	}
	return server
}

func previewRequest(method string) *http.Request {
	mediaID := "m_" + strings.Repeat("a", 43)
	return httptest.NewRequest(method, "/api/v1/media/"+mediaID+"/preview?centerMs=100", nil)
}

func TestPreviewHTTPMapsDomainErrorsForGetAndHead(t *testing.T) {
	tests := []struct {
		name       string
		err        error
		status     int
		code       string
		retryAfter string
	}{
		{name: "source changed", err: index.ErrSourceChanged, status: http.StatusConflict, code: "source_changed"},
		{name: "missing", err: index.ErrNotFound, status: http.StatusNotFound, code: "not_found"},
		{name: "limit", err: projects.ErrGlobalLimit, status: http.StatusTooManyRequests, code: "preview_busy", retryAfter: "1"},
		{name: "internal", err: errors.New("ffmpeg failed"), status: http.StatusInternalServerError, code: "internal_error"},
		{name: "deadline", err: context.DeadlineExceeded, status: http.StatusGatewayTimeout, code: "preview_timeout"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			for _, method := range []string{http.MethodGet, http.MethodHead} {
				server := newPreviewErrorServer(t, previewErrorService{startErr: test.err, cachedErr: test.err})
				response := httptest.NewRecorder()
				server.ServeHTTP(response, previewRequest(method))
				if response.Code != test.status {
					t.Fatalf("%s status=%d want=%d body=%s", method, response.Code, test.status, response.Body.String())
				}
				if method == http.MethodHead && test.retryAfter != "" && response.Header().Get("Retry-After") != test.retryAfter {
					t.Fatalf("%s Retry-After=%q", method, response.Header().Get("Retry-After"))
				}
				if test.code != "" && !strings.Contains(response.Body.String(), `"code":"`+test.code+`"`) {
					// HEAD responses have no body, but still carry the mapped status.
					if method == http.MethodGet {
						t.Fatalf("%s body=%s", method, response.Body.String())
					}
				}
			}
		})
	}
}

func TestPreviewHTTPDoesNotTurnCancellationIntoCapacityError(t *testing.T) {
	server := newPreviewErrorServer(t, previewErrorService{startErr: context.Canceled, cachedErr: context.Canceled})
	for _, method := range []string{http.MethodGet, http.MethodHead} {
		request := previewRequest(method).WithContext(context.Background())
		response := httptest.NewRecorder()
		server.ServeHTTP(response, request)
		if response.Code == http.StatusTooManyRequests || response.Body.Len() != 0 {
			t.Fatalf("%s cancellation response=%d body=%q", method, response.Code, response.Body.String())
		}
	}
}

type sourceValidatingAssets struct {
	err error
}

func (s sourceValidatingAssets) ValidateSource(context.Context, string) error {
	return s.err
}

func (sourceValidatingAssets) Thumbnails(context.Context, AssetSpec) (AssetResult, error) {
	return AssetResult{}, errors.New("thumbnail should not run")
}

func (sourceValidatingAssets) Waveform(context.Context, AssetSpec) (AssetResult, error) {
	return AssetResult{}, errors.New("waveform should not run")
}

func TestConditionalAssetsValidateSourceBefore304(t *testing.T) {
	authenticator, err := NewAuthenticator(AuthConfig{Mode: "none"})
	if err != nil {
		t.Fatal(err)
	}
	mediaID := "m_" + strings.Repeat("a", 43)
	server, err := New(Config{
		Authenticator: authenticator,
		Media:         previewHandlerMedia{item: Media{ID: mediaID, DurationMS: 1_000, ETag: "source-v1", Streams: map[string]any{"audio": map[string]any{}}}},
		Assets:        sourceValidatingAssets{err: index.ErrSourceChanged},
		Preview:       routeTestPreview{},
		Projects:      routeTestProjects{},
		BatchExports:  &routeTestBatchExports{},
		Jobs:          &routeTestJobs{},
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{
		"/api/v1/media/" + mediaID + "/thumbnails?startMs=0&durationMs=1000&count=1&width=80",
		"/api/v1/media/" + mediaID + "/waveform?startMs=0&durationMs=1000&samples=16",
	} {
		request := httptest.NewRequest(http.MethodGet, path, nil)
		kind := "thumbnails-v2"
		if strings.Contains(path, "/waveform?") {
			kind = "waveform-v2"
		}
		etagResponse := httptest.NewRecorder()
		assetNotModified(etagResponse, request, Media{ID: mediaID, ETag: "source-v1"}, kind)
		request.Header.Set("If-None-Match", etagResponse.Header().Get("ETag"))
		response := httptest.NewRecorder()
		server.ServeHTTP(response, request)
		if response.Code != http.StatusConflict || !strings.Contains(response.Body.String(), `"code":"source_changed"`) {
			t.Fatalf("%s response=%d body=%s", path, response.Code, response.Body.String())
		}
	}
}
