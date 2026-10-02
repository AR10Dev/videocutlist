package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestJobEventStreamSendsTerminalSnapshotAndResynchronizesInvalidCursor(t *testing.T) {
	authenticator, err := NewAuthenticator(AuthConfig{Mode: "bearer", BearerToken: "stream-secret"})
	if err != nil {
		t.Fatal(err)
	}
	job := Job{ID: "j_aaaaaaaaaaaa", Type: "export", State: "succeeded", Revision: 2}
	jobs := &routeTestJobs{job: job}
	server, err := New(Config{
		Authenticator: authenticator,
		Media:         &routeTestMedia{}, Preview: routeTestPreview{}, Projects: routeTestProjects{},
		BatchExports: &routeTestBatchExports{}, Jobs: jobs,
	})
	if err != nil {
		t.Fatal(err)
	}

	unauthorized := httptest.NewRecorder()
	server.ServeHTTP(unauthorized, httptest.NewRequest(http.MethodGet, "http://api.test/api/v2/jobs/"+job.ID+"/events", nil))
	if unauthorized.Code != http.StatusUnauthorized || jobs.gets != 0 {
		t.Fatalf("unauthenticated stream status=%d, job reads=%d", unauthorized.Code, jobs.gets)
	}

	for _, test := range []struct {
		name, cursor, event string
		sendCursor          bool
	}{
		{name: "initial", event: "snapshot"},
		{name: "empty cursor", event: "resync", sendCursor: true},
		{name: "current cursor", cursor: "j_aaaaaaaaaaaa:2", event: "snapshot", sendCursor: true},
		{name: "malformed cursor", cursor: "not-a-cursor", event: "resync", sendCursor: true},
		{name: "mismatched cursor", cursor: "j_bbbbbbbbbbbb:1", event: "resync", sendCursor: true},
		{name: "stale cursor", cursor: "j_aaaaaaaaaaaa:1", event: "resync", sendCursor: true},
		{name: "ahead cursor", cursor: "j_aaaaaaaaaaaa:3", event: "resync", sendCursor: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, "http://api.test/api/v2/jobs/"+job.ID+"/events", nil)
			request.Header.Set("Authorization", "Bearer stream-secret")
			if test.sendCursor {
				request.Header.Set("Last-Event-ID", test.cursor)
			}
			response := httptest.NewRecorder()
			server.ServeHTTP(response, request)
			if response.Code != http.StatusOK {
				t.Fatalf("status = %d, body %s", response.Code, response.Body.String())
			}
			if got := response.Header().Get("Content-Type"); got != "text/event-stream" {
				t.Fatalf("Content-Type = %q", got)
			}
			body := response.Body.String()
			if !strings.Contains(body, "event: "+test.event+"\n") || !strings.Contains(body, "id: j_aaaaaaaaaaaa:2\n") || !strings.Contains(body, "data: ") || !strings.HasSuffix(body, "\n\n") {
				t.Fatalf("invalid SSE framing: %q", body)
			}
			data := strings.Split(strings.Split(body, "data: ")[1], "\n")[0]
			var got struct {
				ID       string `json:"id"`
				State    string `json:"state"`
				Revision int64  `json:"revision"`
			}
			if err := json.Unmarshal([]byte(data), &got); err != nil {
				t.Fatal(err)
			}
			if got.ID != job.ID || got.State != "succeeded" || got.Revision != 2 {
				t.Fatalf("snapshot = %#v", got)
			}
		})
	}
}

func TestJobEventStreamReleasesObservationOnDisconnectAndShutdown(t *testing.T) {
	for _, shutdown := range []bool{false, true} {
		t.Run(map[bool]string{false: "disconnect", true: "shutdown"}[shutdown], func(t *testing.T) {
			authenticator, err := NewAuthenticator(AuthConfig{Mode: "none"})
			if err != nil {
				t.Fatal(err)
			}
			jobs := &streamTestJobs{job: Job{ID: "j_aaaaaaaaaaaa", Type: "export", State: "running"}}
			server, err := New(Config{
				Authenticator: authenticator,
				Media:         &routeTestMedia{}, Preview: routeTestPreview{}, Projects: routeTestProjects{},
				BatchExports: &routeTestBatchExports{}, Jobs: jobs,
			})
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			writer := &cancelAfterFlushWriter{ResponseRecorder: httptest.NewRecorder()}
			if shutdown {
				writer.afterFlush = server.Shutdown
			} else {
				writer.afterFlush = cancel
			}
			request := httptest.NewRequest(http.MethodGet, "http://api.test/api/v2/jobs/"+jobs.job.ID+"/events", nil).WithContext(ctx)
			server.ServeHTTP(writer, request)
			if got := jobs.gets; got != 1 {
				t.Fatalf("snapshot reads after close = %d, want 1", got)
			}
			if writer.flushed != 1 {
				t.Fatalf("flush count = %d, want 1", writer.flushed)
			}
		})
	}
}

type streamTestJobs struct {
	job  Job
	gets int
}

func (s *streamTestJobs) Get(context.Context, string) (Job, error) {
	s.gets++
	return s.job, nil
}
func (*streamTestJobs) Cancel(context.Context, string) error { return nil }

type cancelAfterFlushWriter struct {
	*httptest.ResponseRecorder
	afterFlush func()
	flushed    int
}

func (w *cancelAfterFlushWriter) Flush() {
	w.flushed++
	w.afterFlush()
}
