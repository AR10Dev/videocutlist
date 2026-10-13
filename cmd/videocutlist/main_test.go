package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"os"
	"strconv"
	"sync"
	"syscall"
	"testing"
	"time"
	testsupport "videocutlist/internal/testsupport"

	"videocutlist/internal/db"
	jobqueue "videocutlist/internal/jobs/model"
	"videocutlist/internal/library/media/index"
)

func TestRunRecoversUnifiedJobsOnStartup(t *testing.T) {
	directory := t.TempDir()
	databasePath := directory + "/videocutlist.db"
	db, err := store.OpenDatabase(context.Background(), databasePath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Error(err)
		}
	})
	jobs, err := testsupport.NewJobsStore(db)
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
	for i := range 4 {
		id := strconv.Itoa(i)
		if _, err := jobs.Create(context.Background(), jobqueue.Job{ID: "j_queued000000" + id, BatchID: "b_queued000000" + id, Kind: jobqueue.JobScan, RequestJSON: `{}`}); err != nil {
			t.Fatal(err)
		}
	}
	port := "0"
	t.Setenv("VIDEOCUTLIST_DATABASE_PATH", databasePath)
	t.Setenv("VIDEOCUTLIST_CACHE_DIR", directory+"/cache")
	t.Setenv("VIDEOCUTLIST_EXPORT_DIR", directory+"/exports")
	t.Setenv("VIDEOCUTLIST_MEDIA_ROOTS_JSON", `{"media":"`+directory+`"}`)
	t.Setenv("VIDEOCUTLIST_LISTEN_ADDRESS", "127.0.0.1")
	t.Setenv("VIDEOCUTLIST_PORT", port)
	t.Setenv("VIDEOCUTLIST_EXPORT_LIMIT", "1")
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

var runStdoutCapture sync.Mutex

func startRunCapturingAddress(t *testing.T, ctx context.Context, cancel context.CancelFunc) (string, <-chan error, <-chan struct{}, func()) {
	t.Helper()
	runStdoutCapture.Lock()
	originalStdout := os.Stdout
	reader, writer, err := os.Pipe()
	if err != nil {
		runStdoutCapture.Unlock()
		t.Fatal(err)
	}
	os.Stdout = writer
	runDone := make(chan error, 1)
	cleanupExited := make(chan struct{})
	finished := make(chan struct{})
	go func() {
		runDone <- runWithCleanupExit(ctx, cleanupExited)
		close(finished)
	}()
	address := make(chan string, 1)
	readDone := make(chan struct{})
	go func() {
		defer close(readDone)
		scanner := bufio.NewScanner(reader)
		reported := false
		for scanner.Scan() {
			if reported {
				continue
			}
			var event struct {
				Event      string `json:"event"`
				ListenAddr string `json:"listen_addr"`
			}
			if json.Unmarshal(scanner.Bytes(), &event) == nil && event.Event == "server_started" {
				address <- event.ListenAddr
				reported = true
			}
		}
	}()
	var stopOnce sync.Once
	stop := func() {
		stopOnce.Do(func() {
			cancel()
			<-finished
			_ = writer.Close()
			os.Stdout = originalStdout
			_ = reader.Close()
			<-readDone
			runStdoutCapture.Unlock()
		})
	}
	t.Cleanup(stop)
	select {
	case listenAddr := <-address:
		return listenAddr, runDone, cleanupExited, stop
	case err := <-runDone:
		stop()
		t.Fatalf("server stopped before reporting its listening address: %v", err)
	case <-time.After(5 * time.Second):
		stop()
		t.Fatal("server did not report its listening address")
	}
	return "", runDone, cleanupExited, stop
}

func TestRunCleanupExitsAfterListenFailureWithLiveCallerContext(t *testing.T) {
	occupied, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := occupied.Close(); err != nil {
			t.Error(err)
		}
	}()
	host, port, err := net.SplitHostPort(occupied.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	directory := t.TempDir()
	t.Setenv("VIDEOCUTLIST_DATABASE_PATH", directory+"/videocutlist.db")
	t.Setenv("VIDEOCUTLIST_CACHE_DIR", directory+"/cache")
	t.Setenv("VIDEOCUTLIST_EXPORT_DIR", directory+"/exports")
	t.Setenv("VIDEOCUTLIST_MEDIA_ROOTS_JSON", "{}")
	t.Setenv("VIDEOCUTLIST_LISTEN_ADDRESS", host)
	t.Setenv("VIDEOCUTLIST_PORT", port)

	ctx, cancel := context.WithCancel(t.Context())
	cleanupExited := make(chan struct{})
	defer func() {
		cancel()
		select {
		case <-cleanupExited:
		case <-time.After(time.Second):
			t.Error("cleanup goroutine did not exit after caller cancellation")
		}
	}()
	runDone := make(chan error, 1)
	go func() { runDone <- runWithCleanupExit(ctx, cleanupExited) }()
	select {
	case err := <-runDone:
		if !errors.Is(err, syscall.EADDRINUSE) {
			t.Fatalf("run error = %v, want address-in-use listen failure", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("run did not return after listen failure")
	}
	if ctx.Err() != nil {
		t.Fatalf("caller context was canceled: %v", ctx.Err())
	}
	select {
	case <-cleanupExited:
	case <-time.After(200 * time.Millisecond):
		t.Error("cleanup goroutine outlived run while caller context remained live")
	}
}

func TestRunWithNoMediaRootsHidesRemovedRootAndServesAPI(t *testing.T) {
	directory := t.TempDir()
	databasePath := directory + "/videocutlist.db"
	database, err := store.OpenDatabase(t.Context(), databasePath)
	if err != nil {
		t.Fatal(err)
	}
	media, err := store.NewMediaStore(database)
	if err != nil {
		t.Fatal(err)
	}
	record := index.Record{Media: index.Media{ID: index.MediaID("removed", "old.mp4"), Name: "old.mp4", SizeBytes: 1, MtimeNS: 1}, RootAlias: "removed", RelativePath: "old.mp4"}
	if err := media.Sync(t.Context(), "removed", []index.Record{record}); err != nil {
		t.Fatal(err)
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}
	port := "0"
	t.Setenv("VIDEOCUTLIST_DATABASE_PATH", databasePath)
	t.Setenv("VIDEOCUTLIST_CACHE_DIR", directory+"/cache")
	t.Setenv("VIDEOCUTLIST_EXPORT_DIR", directory+"/exports")
	t.Setenv("VIDEOCUTLIST_MEDIA_ROOTS_JSON", "{}")
	t.Setenv("VIDEOCUTLIST_LISTEN_ADDRESS", "127.0.0.1")
	t.Setenv("VIDEOCUTLIST_PORT", port)
	ctx, cancel := context.WithCancel(t.Context())
	listenAddress, done, cleanupExited, stop := startRunCapturingAddress(t, ctx, cancel)
	defer stop()
	base := "http://" + listenAddress
	deadline := time.Now().Add(5 * time.Second)
	for {
		select {
		case err := <-done:
			t.Fatalf("unconfigured server stopped before serving: %v", err)
		default:
		}
		response, err := http.Get(base + "/ready")
		if err == nil {
			_ = response.Body.Close()
			if response.StatusCode == http.StatusOK {
				break
			}
		}
		if time.Now().After(deadline) {
			t.Fatal("unconfigured server did not become ready")
		}
		time.Sleep(10 * time.Millisecond)
	}
	for path, check := range map[string]func(*json.Decoder) error{
		"/api/v2/media": func(decoder *json.Decoder) error {
			var page struct {
				Items []json.RawMessage `json:"items"`
			}
			if err := decoder.Decode(&page); err != nil {
				return err
			}
			if len(page.Items) != 0 {
				return errors.New("removed root is still listed")
			}
			return nil
		},
		"/api/v2/media/status": func(decoder *json.Decoder) error {
			var status struct {
				State string `json:"state"`
			}
			if err := decoder.Decode(&status); err != nil {
				return err
			}
			if status.State != "unconfigured" {
				return errors.New("library status is not unconfigured")
			}
			return nil
		},
	} {
		response, err := http.Get(base + path)
		if err != nil {
			t.Fatal(err)
		}
		if response.StatusCode != http.StatusOK {
			_ = response.Body.Close()
			t.Fatalf("%s status = %d", path, response.StatusCode)
		}
		decodeErr := check(json.NewDecoder(response.Body))
		closeErr := response.Body.Close()
		if err := errors.Join(decodeErr, closeErr); err != nil {
			t.Fatalf("%s: %v", path, err)
		}
	}
	cancel()
	stop()
	if err := <-done; err != nil {
		t.Fatalf("shutdown unconfigured server: %v", err)
	}
	select {
	case <-cleanupExited:
	case <-time.After(time.Second):
		t.Fatal("cleanup goroutine did not exit after normal cancellation")
	}
}
