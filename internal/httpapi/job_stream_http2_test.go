package httpapi

import (
	"bufio"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"videocutlist/internal/projects"
)

func TestHTTP2JobAndBatchStreamsSurviveWriteTimeoutAndCloseTerminally(t *testing.T) {
	authenticator, err := NewAuthenticator(AuthConfig{Mode: "none"})
	if err != nil {
		t.Fatal(err)
	}
	jobs := &http2StreamJobs{}
	batches := &http2StreamBatches{routeTestBatchExports: &routeTestBatchExports{}}
	api, err := New(Config{
		Authenticator: authenticator,
		Media:         &routeTestMedia{}, Preview: routeTestPreview{}, Projects: routeTestProjects{},
		BatchExports: batches, Jobs: jobs,
	})
	if err != nil {
		t.Fatal(err)
	}
	var jobRequests, batchRequests atomic.Int32
	httpServer := httptest.NewUnstartedServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if strings.Contains(request.URL.Path, "/jobs/") {
			jobRequests.Add(1)
		} else if strings.Contains(request.URL.Path, "/batches/") {
			batchRequests.Add(1)
		}
		api.ServeHTTP(writer, request)
	}))
	httpServer.EnableHTTP2 = true
	httpServer.StartTLS()
	defer httpServer.Close()

	ctx, cancel := context.WithTimeout(t.Context(), 25*time.Second)
	defer cancel()
	client := httpServer.Client()
	jobResponse := openHTTP2SSE(t, ctx, client, httpServer.URL+"/api/v2/jobs/j_aaaaaaaaaaaa/events")
	defer func() {
		if err := jobResponse.Body.Close(); err != nil {
			t.Error(err)
		}
	}()
	batchResponse := openHTTP2SSE(t, ctx, client, httpServer.URL+"/api/v2/batches/b_aaaaaaaaaaaa/events")
	defer func() {
		if err := batchResponse.Body.Close(); err != nil {
			t.Error(err)
		}
	}()
	jobScanner, batchScanner := bufio.NewScanner(jobResponse.Body), bufio.NewScanner(batchResponse.Body)
	if block, err := readSSEBlock(jobScanner); err != nil || !strings.Contains(block, "event: snapshot") || !strings.Contains(block, `"state":"running"`) {
		t.Fatalf("initial job snapshot = %q, error=%v", block, err)
	}
	if block, err := readSSEBlock(batchScanner); err != nil || !strings.Contains(block, "event: snapshot") || !strings.Contains(block, `"state":"running"`) {
		t.Fatalf("initial batch snapshot = %q, error=%v", block, err)
	}

	type heartbeatResult struct {
		name  string
		block string
		err   error
	}
	heartbeats := make(chan heartbeatResult, 2)
	go func() {
		block, err := readSSEBlock(jobScanner)
		heartbeats <- heartbeatResult{name: "job", block: block, err: err}
	}()
	go func() {
		block, err := readSSEBlock(batchScanner)
		heartbeats <- heartbeatResult{name: "batch", block: block, err: err}
	}()
	for range 2 {
		select {
		case result := <-heartbeats:
			if result.err != nil || !strings.Contains(result.block, ": keepalive") {
				t.Fatalf("%s heartbeat block = %q, error=%v", result.name, result.block, result.err)
			}
		case <-ctx.Done():
			t.Fatalf("timed out waiting for HTTP/2 heartbeat: %v", ctx.Err())
		}
	}
	jobs.terminal.Store(true)
	batches.terminal.Store(true)

	if block, err := readSSEBlock(jobScanner); err != nil || !strings.Contains(block, "event: snapshot") || !strings.Contains(block, `"state":"succeeded"`) {
		t.Fatalf("terminal job snapshot = %q, error=%v", block, err)
	}
	if block, err := readSSEBlock(batchScanner); err != nil || !strings.Contains(block, "event: snapshot") || !strings.Contains(block, `"state":"succeeded"`) {
		t.Fatalf("terminal batch snapshot = %q, error=%v", block, err)
	}
	if jobScanner.Scan() || jobScanner.Err() != nil {
		t.Fatalf("job SSE did not close cleanly: line=%q error=%v", jobScanner.Text(), jobScanner.Err())
	}
	if batchScanner.Scan() || batchScanner.Err() != nil {
		t.Fatalf("batch SSE did not close cleanly: line=%q error=%v", batchScanner.Text(), batchScanner.Err())
	}
	if jobRequests.Load() != 1 || batchRequests.Load() != 1 {
		t.Fatalf("HTTP/2 request counts = job:%d batch:%d, want one each", jobRequests.Load(), batchRequests.Load())
	}
}

func openHTTP2SSE(t *testing.T, ctx context.Context, client *http.Client, url string) *http.Response {
	t.Helper()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	if response.ProtoMajor != 2 || response.StatusCode != http.StatusOK {
		if err := response.Body.Close(); err != nil {
			t.Error(err)
		}
		t.Fatalf("HTTP/2 SSE response protocol=%s status=%d", response.Proto, response.StatusCode)
	}
	return response
}

func readSSEBlock(scanner *bufio.Scanner) (string, error) {
	var block strings.Builder
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			return block.String(), nil
		}
		block.WriteString(line)
		block.WriteByte('\n')
	}
	if err := scanner.Err(); err != nil {
		return block.String(), err
	}
	return block.String(), io.EOF
}

type http2StreamJobs struct{ terminal atomic.Bool }

func (j *http2StreamJobs) Get(_ context.Context, id string) (Job, error) {
	if j.terminal.Load() {
		return Job{ID: id, Type: "export", State: "succeeded", Revision: 2}, nil
	}
	return Job{ID: id, Type: "export", State: "running", Revision: 1}, nil
}

func (*http2StreamJobs) Cancel(context.Context, string) error { return nil }

type http2StreamBatches struct {
	*routeTestBatchExports
	terminal atomic.Bool
}

func (b *http2StreamBatches) Snapshot(_ context.Context, id string) (projects.Batch, string, error) {
	if b.terminal.Load() {
		return projects.Batch{BatchID: id, State: "succeeded", Jobs: []projects.Job{}}, "b2_done", nil
	}
	return projects.Batch{BatchID: id, State: "running", Jobs: []projects.Job{}}, "b2_running", nil
}
