package main

import (
	"context"
	"errors"
	"net"
	"net/http"
	"strconv"
	"testing"
	"time"

	"videocutlist/internal/db"
	jobqueue "videocutlist/internal/jobs"
	"videocutlist/internal/settings"
)

func TestRunRecoversUnifiedJobsOnStartup(t *testing.T) {
	databasePath := t.TempDir() + "/videocutlist.db"
	db, err := store.OpenDatabase(context.Background(), databasePath)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	jobs, err := jobqueue.NewJobsStore(db)
	if err != nil {
		t.Fatal(err)
	}
	job, err := jobs.Create(context.Background(), jobqueue.Job{ID: "j_restart00000", BatchID: "b_restart00000", Kind: jobqueue.JobScan, RequestJSON: `{}`})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := jobs.Start(context.Background(), job.ID); err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := strconv.Itoa(listener.Addr().(*net.TCPAddr).Port)
	listener.Close()
	directory := t.TempDir()
	t.Setenv("VIDEOCUTLIST_DATABASE_PATH", databasePath)
	t.Setenv("VIDEOCUTLIST_CACHE_DIR", directory+"/cache")
	t.Setenv("VIDEOCUTLIST_EXPORT_DIR", directory+"/exports")
	t.Setenv("VIDEOCUTLIST_MEDIA_ROOTS_JSON", `{}`)
	t.Setenv("VIDEOCUTLIST_LISTEN_ADDRESS", "127.0.0.1")
	t.Setenv("VIDEOCUTLIST_PORT", port)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- run(ctx) }()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		value, err := jobs.Get(context.Background(), job.ID)
		if err == nil && value.State == jobqueue.JobFailed && value.ErrorCode.Valid && value.ErrorCode.String == "interrupted_by_restart" {
			cancel()
			if err := <-done; err != nil {
				t.Fatalf("run = %v", err)
			}
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	<-done
	t.Fatal("startup did not recover a running unified job")
}

func TestNewHTTPServerUsesConfiguredAddressAndTimeouts(t *testing.T) {
	cfg := config.Config{
		ListenAddr:   "127.0.0.1:0",
		ReadTimeout:  2 * time.Second,
		WriteTimeout: 0,
		IdleTimeout:  3 * time.Minute,
	}
	server := newHTTPServer(cfg, http.NewServeMux())
	if server.Addr != cfg.ListenAddr || server.ReadTimeout != cfg.ReadTimeout || server.WriteTimeout != cfg.WriteTimeout || server.IdleTimeout != cfg.IdleTimeout {
		t.Fatalf("server = %#v, config = %#v", server, cfg)
	}
	if server.ReadHeaderTimeout != 5*time.Second {
		t.Fatalf("ReadHeaderTimeout = %s, want 5s", server.ReadHeaderTimeout)
	}
}

func TestNewHTTPServerBindsConfiguredAddresses(t *testing.T) {
	for _, test := range []struct {
		name string
		addr string
	}{
		{name: "loopback", addr: "127.0.0.1:0"},
		{name: "all IPv4 interfaces", addr: "0.0.0.0:0"},
	} {
		t.Run(test.name, func(t *testing.T) {
			server := newHTTPServer(config.Config{ListenAddr: test.addr}, http.NewServeMux())
			listener, err := net.Listen("tcp", server.Addr)
			if err != nil {
				t.Fatal(err)
			}
			defer listener.Close()
			if _, port, err := net.SplitHostPort(listener.Addr().String()); err != nil || port == "0" {
				t.Fatalf("listener address = %q, err = %v", listener.Addr(), err)
			}
		})
	}
}

func TestNewHTTPServerServesLoopback(t *testing.T) {
	server := newHTTPServer(config.Config{ListenAddr: "127.0.0.1:0"}, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	listener, err := net.Listen("tcp", server.Addr)
	if err != nil {
		t.Fatal(err)
	}
	result := make(chan error, 1)
	go func() { result <- server.Serve(listener) }()

	response, err := http.Get("http://" + listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusNoContent {
		t.Fatalf("status = %d, want %d", response.StatusCode, http.StatusNoContent)
	}
	if err := server.Close(); err != nil {
		t.Fatal(err)
	}
	if err := <-result; !errors.Is(err, http.ErrServerClosed) {
		t.Fatalf("Serve error = %v, want %v", err, http.ErrServerClosed)
	}
}
