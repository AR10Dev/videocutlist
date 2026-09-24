package runtime

import (
	"bytes"
	"context"
	"errors"
	"image"
	"image/png"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"videocutlist/internal/db"
	"videocutlist/internal/jobs"
	"videocutlist/internal/library/media/index"
	"videocutlist/internal/preview/cache"
	"videocutlist/internal/projects"
	settingsdomain "videocutlist/internal/settings"
	"videocutlist/internal/web/assets"
)

func TestApplyRuntimeSettingsTransactionalRestoresAfterScannerFailure(t *testing.T) {
	previous := store.RuntimeSettings{MediaRoots: map[string]string{"old": "/old"}, CacheMaxBytes: 10}
	next := store.RuntimeSettings{MediaRoots: map[string]string{"new": "/new"}, CacheMaxBytes: 20}
	var calls []string
	fail := errors.New("scanner failed")
	err := applyRuntimeSettingsTransactional(next, previous,
		func(value store.RuntimeSettings) error {
			calls = append(calls, "config:"+value.MediaRoots["old"]+value.MediaRoots["new"])
			return nil
		},
		func(value store.RuntimeSettings) error {
			calls = append(calls, "roots:"+value.MediaRoots["old"]+value.MediaRoots["new"])
			if value.MediaRoots["new"] != "" {
				return fail
			}
			return nil
		},
		func(value store.RuntimeSettings) error { calls = append(calls, "scan"); return nil },
		func(value store.RuntimeSettings) error { calls = append(calls, "preview"); return nil },
		func(value store.RuntimeSettings) error { calls = append(calls, "cache"); return nil },
	)
	if !errors.Is(err, fail) {
		t.Fatalf("error = %v", err)
	}
	want := []string{"config:/new", "roots:/new", "cache", "preview", "scan", "roots:/old", "config:/old"}
	if !reflect.DeepEqual(calls, want) {
		t.Fatalf("calls = %#v, want %#v", calls, want)
	}
}

func TestApplyRuntimeSettingsTransactionalRestoresAfterLaterFailure(t *testing.T) {
	previous := store.RuntimeSettings{MediaRoots: map[string]string{"old": "/old"}, CacheMaxBytes: 10}
	next := store.RuntimeSettings{MediaRoots: map[string]string{"new": "/new"}, CacheMaxBytes: 20}
	var calls []string
	fail := errors.New("preview failed")
	step := func(name string, failure bool) func(store.RuntimeSettings) error {
		return func(value store.RuntimeSettings) error {
			calls = append(calls, name+value.MediaRoots["old"]+value.MediaRoots["new"])
			if failure && value.MediaRoots["new"] != "" {
				return fail
			}
			return nil
		}
	}
	err := applyRuntimeSettingsTransactional(next, previous,
		step("config:", false), step("roots:", false), step("scan:", false), step("preview:", true), step("cache:", false))
	if !errors.Is(err, fail) {
		t.Fatalf("error = %v", err)
	}
	want := []string{"config:/new", "roots:/new", "scan:/new", "preview:/new", "cache:/old", "preview:/old", "scan:/old", "roots:/old", "config:/old"}
	if !reflect.DeepEqual(calls, want) {
		for i := range want {
			if calls[i] != want[i] {
				t.Fatalf("call %d = %q, want %q", i, calls[i], want[i])
			}
		}
		t.Fatalf("calls = %q, want %q", calls, want)
	}
}

func TestRuntimeSettingsApplierUpdatesSchedulerAndBothCaches(t *testing.T) {
	db, err := store.OpenDatabase(t.Context(), filepath.Join(t.TempDir(), "runtime.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := db.Close(); err != nil {
			t.Error(err)
		}
	}()
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "clip.mp4"), []byte("fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	scanner, err := index.NewScanner([]index.Root{{Alias: "library", Path: root}}, adapterProbe{})
	if err != nil {
		t.Fatal(err)
	}
	media, _ := store.NewMediaStore(db)
	if err := scanner.Refresh(t.Context(), media); err != nil {
		t.Fatal(err)
	}
	var pngData bytes.Buffer
	if err := png.Encode(&pngData, image.NewRGBA(image.Rect(0, 0, 80, 80))); err != nil {
		t.Fatal(err)
	}
	command := filepath.Join(t.TempDir(), "ffmpeg")
	if err := os.WriteFile(command, []byte("#!/bin/sh\ncat \"$0.output\"\n"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(command+".output", pngData.Bytes(), 0600); err != nil {
		t.Fatal(err)
	}
	previewCache, err := cache.New(t.TempDir(), 1024)
	if err != nil {
		t.Fatal(err)
	}
	assetService := &assets.Service{Scanner: scanner, Media: media, FFmpegPath: command, CacheDir: t.TempDir(), MaxBytes: 1024}
	limits, _ := projects.NewPreviewLimits(2)
	jobStore, _ := jobs.NewJobsStore(db)
	started := make(chan string, 2)
	scheduler, err := jobs.NewScheduler(jobStore, jobs.SchedulerConfig{QueueCapacity: 4, WorkerLimit: 1}, func(ctx context.Context, job jobs.Job) error {
		started <- job.ID
		<-ctx.Done()
		return ctx.Err()
	})
	if err != nil {
		t.Fatal(err)
	}
	scheduler.Start()
	defer func() {
		if err := scheduler.Shutdown(t.Context()); err != nil {
			t.Error(err)
		}
	}()
	defaults := store.RuntimeSettings{MediaRoots: map[string]string{"library": root}, Destinations: []store.RuntimeDestination{{ID: "download", Label: "Downloads", Kind: "download", Root: t.TempDir()}}, ExportLimit: 1, CacheMaxBytes: 1024, PreviewGlobalLimit: 2, PreviewBeforeMS: 1, PreviewAfterMS: 1, PreviewMaxMS: 2, PreviewGridMS: 1, MediaMaxFiles: 10, MediaMaxDepth: 2}
	state := store.NewRuntimeSettingsState(defaults)
	applier := RuntimeSettingsApplier{State: state, Scanner: scanner, PreviewLimits: limits, PreviewCache: previewCache, Assets: assetService, Scheduler: scheduler}
	settingsStore, _ := store.NewRuntimeSettingsStore(db)
	record, err := settingsStore.Seed(t.Context(), defaults)
	if err != nil {
		t.Fatal(err)
	}
	service := settingsdomain.NewRuntimeService(settingsStore, state, applier.Apply)
	for _, limit := range []int{0, 65, math.MaxInt} {
		invalid := defaults
		invalid.ExportLimit = limit
		if err := applier.Apply(t.Context(), invalid); err == nil {
			t.Fatal("unsafe limit accepted")
		}
		if _, err := service.Update(t.Context(), record.Revision, invalid, settingsdomain.DeploymentDocument{}); !errors.Is(err, settingsdomain.ErrInvalidSettings) {
			t.Fatalf("invalid settings = %v", err)
		}
		if assetService.MaxBytes != 1024 {
			t.Fatal("validation occurred after mutation")
		}
	}
	if _, err := scheduler.Submit(t.Context(), []jobs.Job{
		{ID: "j_aaaaaaaaaaaa", BatchID: "b_aaaaaaaaaaaa", Kind: jobs.JobScan, RequestJSON: `{}`},
		{ID: "j_bbbbbbbbbbbb", BatchID: "b_bbbbbbbbbbbb", Kind: jobs.JobScan, RequestJSON: `{}`},
	}); err != nil {
		t.Fatal(err)
	}
	next := func() {
		t.Helper()
		select {
		case <-started:
		case <-time.After(time.Second):
			t.Fatal("worker did not start")
		}
	}
	next()
	candidate := defaults
	candidate.ExportLimit, candidate.CacheMaxBytes = 2, 2
	record, err = service.Update(t.Context(), record.Revision, candidate, settingsdomain.DeploymentDocument{})
	if err != nil {
		t.Fatal(err)
	}
	next()
	checkCaches := func(key string, allowed bool) {
		t.Helper()
		partial, err := previewCache.Begin(strings.Repeat(key, 64))
		if err != nil {
			t.Fatal(err)
		}
		if _, err := partial.Write([]byte("preview")); err != nil {
			t.Fatal(err)
		}
		err = partial.Commit(t.Context(), func(context.Context, string) error { return nil })
		if (err == nil) != allowed {
			t.Fatalf("preview publication = %v, allowed=%v", err, allowed)
		}
		result, err := assetService.Thumbnails(t.Context(), projects.AssetSpec{MediaID: index.MediaID("library", "clip.mp4"), DurationMS: 1000, Count: 1, Width: 80})
		if (err == nil) != allowed {
			t.Fatalf("asset publication = %v, allowed=%v", err, allowed)
		}
		if err == nil {
			if err := result.Reader.Close(); err != nil {
				t.Fatal(err)
			}
		}
	}
	checkCaches("a", false)
	if _, err := service.Update(t.Context(), record.Revision, defaults, settingsdomain.DeploymentDocument{}); err != nil {
		t.Fatal(err)
	}
	checkCaches("b", true)
}
