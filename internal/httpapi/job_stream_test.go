package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	jobqueue "videocutlist/internal/jobs"
	"videocutlist/internal/projects"
)

func TestBatchEventStreamSendsCurrentSnapshotAndResynchronizesCursor(t *testing.T) {
	authenticator, err := NewAuthenticator(AuthConfig{Mode: "bearer", BearerToken: "stream-secret"})
	if err != nil {
		t.Fatal(err)
	}
	service := &streamTestBatches{routeTestBatchExports: &routeTestBatchExports{}}
	server, err := New(Config{
		Authenticator: authenticator,
		Media:         &routeTestMedia{}, Preview: routeTestPreview{}, Projects: routeTestProjects{},
		BatchExports: service, Jobs: &streamTestJobs{},
	})
	if err != nil {
		t.Fatal(err)
	}
	unauthorized := httptest.NewRecorder()
	server.ServeHTTP(unauthorized, httptest.NewRequest(http.MethodGet, "http://api.test/api/v2/batches/b_aaaaaaaaaaaa/events", nil))
	if unauthorized.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated batch stream status = %d", unauthorized.Code)
	}
	for _, test := range []struct{ name, cursor, event string }{
		{name: "initial snapshot", event: "snapshot"},
		{name: "matching reconnect", cursor: "b2_current", event: "snapshot"},
		{name: "stale cursor", cursor: "b2_stale", event: "resync"},
		{name: "malformed cursor", cursor: "invalid", event: "resync"},
	} {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, "http://api.test/api/v2/batches/b_aaaaaaaaaaaa/events", nil)
			request.Header.Set("Authorization", "Bearer stream-secret")
			if test.cursor != "" {
				request.Header.Set("Last-Event-ID", test.cursor)
			}
			response := httptest.NewRecorder()
			server.ServeHTTP(response, request)
			if response.Code != http.StatusOK || response.Header().Get("Content-Type") != "text/event-stream" {
				t.Fatalf("status=%d headers=%v body=%s", response.Code, response.Header(), response.Body.String())
			}
			body := response.Body.String()
			if !strings.Contains(body, "id: b2_current\nevent: "+test.event+"\n") || !strings.Contains(body, `"batchId":"b_aaaaaaaaaaaa"`) || !strings.HasSuffix(body, "\n\n") {
				t.Fatalf("unexpected batch SSE: %q", body)
			}
		})
	}
}

type streamTestBatches struct{ *routeTestBatchExports }

func (*streamTestBatches) Snapshot(_ context.Context, id string) (projects.Batch, string, error) {
	if id != "b_aaaaaaaaaaaa" {
		return projects.Batch{}, "", jobqueue.ErrJobNotFound
	}
	return projects.Batch{BatchID: id, State: "succeeded", Jobs: []projects.Job{}}, "b2_current", nil
}

type changingStreamBatches struct {
	*routeTestBatchExports
	state string
}

func (b *changingStreamBatches) Snapshot(_ context.Context, id string) (projects.Batch, string, error) {
	return projects.Batch{BatchID: id, State: b.state, Jobs: []projects.Job{}}, "b2_" + b.state, nil
}

func TestBatchEventStreamPublishesChangedTerminalSnapshot(t *testing.T) {
	authenticator, err := NewAuthenticator(AuthConfig{Mode: "none"})
	if err != nil {
		t.Fatal(err)
	}
	batches := &changingStreamBatches{routeTestBatchExports: &routeTestBatchExports{}, state: "running"}
	server, err := New(Config{
		Authenticator: authenticator, Media: &routeTestMedia{}, Preview: routeTestPreview{}, Projects: routeTestProjects{},
		BatchExports: batches, Jobs: &streamTestJobs{},
	})
	if err != nil {
		t.Fatal(err)
	}
	writer := &cancelAfterFlushWriter{ResponseRecorder: httptest.NewRecorder(), afterFlush: func() { batches.state = "succeeded" }}
	server.ServeHTTP(writer, httptest.NewRequest(http.MethodGet, "http://api.test/api/v2/batches/b_aaaaaaaaaaaa/events", nil))
	body := writer.Body.String()
	if !strings.Contains(body, "id: b2_running\nevent: snapshot\n") || !strings.Contains(body, "id: b2_succeeded\nevent: snapshot\n") || !strings.Contains(body, `"state":"succeeded"`) {
		t.Fatalf("changed terminal snapshot missing: %q", body)
	}
}

func TestBatchEventStreamReturnsNotFoundForMissingBatch(t *testing.T) {
	authenticator, err := NewAuthenticator(AuthConfig{Mode: "none"})
	if err != nil {
		t.Fatal(err)
	}
	server, err := New(Config{
		Authenticator: authenticator, Media: &routeTestMedia{}, Preview: routeTestPreview{}, Projects: routeTestProjects{},
		BatchExports: &streamTestBatches{routeTestBatchExports: &routeTestBatchExports{}}, Jobs: &streamTestJobs{},
	})
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	server.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "http://api.test/api/v2/batches/b_bbbbbbbbbbbb/events", nil))
	if response.Code != http.StatusNotFound {
		t.Fatalf("missing batch status = %d, body %s", response.Code, response.Body.String())
	}
}

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

func TestJobAndBatchStreamsShareCapacityAndReleaseOnDisconnectAndShutdown(t *testing.T) {
	authenticator, err := NewAuthenticator(AuthConfig{Mode: "none"})
	if err != nil {
		t.Fatal(err)
	}
	jobs := &capacityTestJobs{}
	batches := &capacityTestBatches{routeTestBatchExports: &routeTestBatchExports{}}
	server, err := New(Config{
		Authenticator: authenticator, Media: &routeTestMedia{}, Preview: routeTestPreview{}, Projects: routeTestProjects{},
		BatchExports: batches, Jobs: jobs,
	})
	if err != nil {
		t.Fatal(err)
	}
	ready := make(chan struct{}, maxConcurrentObservations+1)
	active := make([]activeCapacityStream, 0, maxConcurrentObservations+1)
	start := func(path string) activeCapacityStream {
		ctx, cancel := context.WithCancel(t.Context())
		stream := activeCapacityStream{cancel: cancel, done: make(chan struct{})}
		writer := &capacityFlushWriter{ResponseRecorder: httptest.NewRecorder(), ready: ready}
		request := httptest.NewRequest(http.MethodGet, "http://api.test"+path, nil).WithContext(ctx)
		go func() {
			defer close(stream.done)
			server.ServeHTTP(writer, request)
		}()
		active = append(active, stream)
		return stream
	}
	waitReady := func() {
		t.Helper()
		select {
		case <-ready:
		case <-time.After(5 * time.Second):
			t.Fatal("stream did not send its initial snapshot")
		}
	}
	defer func() {
		server.Shutdown()
		for _, stream := range active {
			stream.cancel()
			<-stream.done
		}
	}()

	for i := range maxConcurrentObservations {
		path := "/api/v2/jobs/j_aaaaaaaaaaaa/events"
		if i%2 == 1 {
			path = "/api/v2/batches/b_aaaaaaaaaaaa/events"
		}
		start(path)
		waitReady()
	}
	if got := jobs.gets.Load() + batches.snapshots.Load(); got != maxConcurrentObservations {
		t.Fatalf("initial resource reads = %d, want %d", got, maxConcurrentObservations)
	}

	overflow := httptest.NewRecorder()
	server.ServeHTTP(overflow, httptest.NewRequest(http.MethodGet, "http://api.test/api/v2/batches/b_aaaaaaaaaaaa/events", nil))
	if overflow.Code != http.StatusTooManyRequests {
		t.Fatalf("over-capacity status = %d, want 429", overflow.Code)
	}
	var response struct {
		Error struct {
			Code      string `json:"code"`
			Message   string `json:"message"`
			RequestID string `json:"requestId"`
		} `json:"error"`
	}
	if err := json.Unmarshal(overflow.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if response.Error.Code != "observation_capacity" || response.Error.Message == "" || response.Error.RequestID == "" || response.Error.RequestID != overflow.Header().Get("X-Request-ID") {
		t.Fatalf("unsafe or mismatched capacity error envelope: %#v, X-Request-ID=%q", response.Error, overflow.Header().Get("X-Request-ID"))
	}
	if got := jobs.gets.Load() + batches.snapshots.Load(); got != maxConcurrentObservations {
		t.Fatalf("rejected batch stream performed a resource read: reads=%d", got)
	}
	jobOverflow := httptest.NewRecorder()
	server.ServeHTTP(jobOverflow, httptest.NewRequest(http.MethodGet, "http://api.test/api/v2/jobs/j_aaaaaaaaaaaa/events", nil))
	if jobOverflow.Code != http.StatusTooManyRequests || jobs.gets.Load() != maxConcurrentObservations/2 {
		t.Fatalf("rejected job stream status=%d, job reads=%d", jobOverflow.Code, jobs.gets.Load())
	}

	// Releasing one job stream admits a batch stream, proving the budget is shared.
	active[0].cancel()
	<-active[0].done
	batchReads := batches.snapshots.Load()
	replacement := start("/api/v2/batches/b_aaaaaaaaaaaa/events")
	waitReady()
	if got := batches.snapshots.Load(); got != batchReads+1 {
		t.Fatalf("replacement batch snapshot reads = %d, want %d", got, batchReads+1)
	}
	replacement.cancel()
	<-replacement.done

	server.Shutdown()
	for _, stream := range active {
		stream.cancel()
		<-stream.done
	}
	if got := len(server.observationSlots); got != 0 {
		t.Fatalf("observation slots retained after shutdown: %d", got)
	}
}

type activeCapacityStream struct {
	cancel context.CancelFunc
	done   chan struct{}
}

type capacityFlushWriter struct {
	*httptest.ResponseRecorder
	ready chan<- struct{}
}

func (w *capacityFlushWriter) Flush() {
	w.ResponseRecorder.Flush()
	w.ready <- struct{}{}
}

type capacityTestJobs struct{ gets atomic.Int64 }

func (j *capacityTestJobs) Get(_ context.Context, id string) (Job, error) {
	j.gets.Add(1)
	return Job{ID: id, Type: "export", State: "running"}, nil
}
func (*capacityTestJobs) Cancel(context.Context, string) error { return nil }

type capacityTestBatches struct {
	*routeTestBatchExports
	snapshots atomic.Int64
}

func (b *capacityTestBatches) Snapshot(_ context.Context, id string) (projects.Batch, string, error) {
	b.snapshots.Add(1)
	return projects.Batch{BatchID: id, State: "running", Jobs: []projects.Job{}}, "b2_current", nil
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
