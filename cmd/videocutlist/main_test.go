package main

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"strconv"
	"testing"
	"time"

	"videocutlist/internal/db"
	jobqueue "videocutlist/internal/jobs"
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
	for i := range 4 {
		id := strconv.Itoa(i)
		if _, err := jobs.Create(context.Background(), jobqueue.Job{ID: "j_queued000000" + id, BatchID: "b_queued000000" + id, Kind: jobqueue.JobScan, RequestJSON: `{}`}); err != nil {
			t.Fatal(err)
		}
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := strconv.Itoa(listener.Addr().(*net.TCPAddr).Port)
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
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
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := strconv.Itoa(listener.Addr().(*net.TCPAddr).Port)
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
	t.Setenv("VIDEOCUTLIST_DATABASE_PATH", databasePath)
	t.Setenv("VIDEOCUTLIST_CACHE_DIR", directory+"/cache")
	t.Setenv("VIDEOCUTLIST_EXPORT_DIR", directory+"/exports")
	t.Setenv("VIDEOCUTLIST_MEDIA_ROOTS_JSON", "{}")
	t.Setenv("VIDEOCUTLIST_LISTEN_ADDRESS", "127.0.0.1")
	t.Setenv("VIDEOCUTLIST_PORT", port)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- run(ctx) }()
	base := "http://127.0.0.1:" + port
	deadline := time.Now().Add(5 * time.Second)
	for {
		select {
		case err := <-done:
			t.Fatalf("unconfigured server stopped before serving: %v", err)
		default:
		}
		response, err := http.Get(base + "/api/v1/ready")
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
		"/api/v1/media": func(decoder *json.Decoder) error {
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
		"/api/v1/media/status": func(decoder *json.Decoder) error {
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
	if err := <-done; err != nil {
		t.Fatalf("shutdown unconfigured server: %v", err)
	}
}
