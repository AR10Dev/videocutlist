package httpapi

import (
	"context"
	"io"
	"net"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestJobEventStreamStalledSocketWriteDeadlineReleasesCapacity(t *testing.T) {
	authenticator, err := NewAuthenticator(AuthConfig{Mode: "none"})
	if err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{})
	jobs := &stalledSocketJobs{started: started, warning: strings.Repeat("x", 8<<20)}
	api, err := New(Config{
		Authenticator: authenticator,
		Media:         &routeTestMedia{}, Preview: routeTestPreview{}, Projects: routeTestProjects{},
		BatchExports: &routeTestBatchExports{}, Jobs: jobs,
	})
	if err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	listener = writeBufferListener{Listener: listener, size: 4096}
	completed := make(chan struct{}, 2)
	httpServer := &http.Server{Handler: http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		defer func() { completed <- struct{}{} }()
		api.ServeHTTP(writer, request)
	})}
	serveDone := make(chan struct{})
	go func() {
		defer close(serveDone)
		_ = httpServer.Serve(listener)
	}()
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(ctx)
		<-serveDone
	}()

	stalled, err := net.Dial("tcp", listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := stalled.Close(); err != nil {
			t.Error(err)
		}
	}()
	stalledTCP := stalled.(*net.TCPConn)
	if err := stalledTCP.SetReadBuffer(4096); err != nil {
		t.Fatal(err)
	}
	if _, err := io.WriteString(stalled, "GET /api/v2/jobs/j_aaaaaaaaaaaa/events HTTP/1.1\r\nHost: api.test\r\n\r\n"); err != nil {
		t.Fatal(err)
	}
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("job service did not start the socket snapshot")
	}

	writeStarted := time.Now()
	select {
	case <-completed:
	case <-time.After(sseWriteTimeout + 4*time.Second):
		t.Fatal("stalled socket write did not release the handler within its deadline")
	}
	if elapsed := time.Since(writeStarted); elapsed < sseWriteTimeout-time.Second {
		t.Fatalf("handler exited too quickly to demonstrate deadline expiry: %s", elapsed)
	}
	if got := len(api.observationSlots); got != 0 {
		t.Fatalf("observation slot retained after stalled socket write: %d", got)
	}

	terminal, err := net.Dial("tcp", listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := terminal.Close(); err != nil {
			t.Error(err)
		}
	}()
	if _, err := io.WriteString(terminal, "GET /api/v2/jobs/j_aaaaaaaaaaaa/events HTTP/1.1\r\nHost: api.test\r\nConnection: close\r\n\r\n"); err != nil {
		t.Fatal(err)
	}
	if err := terminal.SetReadDeadline(time.Now().Add(3 * time.Second)); err != nil {
		t.Fatal(err)
	}
	response, err := io.ReadAll(terminal)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(string(response), "HTTP/1.1 200 OK\r\n") || !strings.Contains(string(response), "event: snapshot\n") {
		t.Fatalf("replacement observation failed: %q", response)
	}
	select {
	case <-completed:
	case <-time.After(time.Second):
		t.Fatal("terminal replacement handler did not finish")
	}
	if got := len(api.observationSlots); got != 0 {
		t.Fatalf("observation slot retained after terminal replacement: %d", got)
	}
}

type stalledSocketJobs struct {
	started chan struct{}
	warning string
	calls   atomic.Int64
}

func (s *stalledSocketJobs) Get(_ context.Context, id string) (Job, error) {
	if s.calls.Add(1) == 1 {
		close(s.started)
		return Job{ID: id, Type: "export", State: "running", Revision: 1, Warnings: []string{s.warning}}, nil
	}
	return Job{ID: id, Type: "export", State: "succeeded", Revision: 2}, nil
}

func (*stalledSocketJobs) Cancel(context.Context, string) error { return nil }

type writeBufferListener struct {
	net.Listener
	size int
}

func (l writeBufferListener) Accept() (net.Conn, error) {
	conn, err := l.Listener.Accept()
	if err != nil {
		return nil, err
	}
	tcp, ok := conn.(*net.TCPConn)
	if !ok {
		_ = conn.Close()
		return nil, http.ErrNotSupported
	}
	if err := tcp.SetWriteBuffer(l.size); err != nil {
		_ = conn.Close()
		return nil, err
	}
	return conn, nil
}
