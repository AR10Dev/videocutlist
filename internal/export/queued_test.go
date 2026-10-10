package export

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"testing"
	"time"
	testsupport "videocutlist/internal/testsupport"

	store "videocutlist/internal/db"
	jobservice "videocutlist/internal/jobs"
	jobqueue "videocutlist/internal/jobs/model"
	librarymedia "videocutlist/internal/library/media"
	"videocutlist/internal/preview"
	"videocutlist/internal/projects/model"
)

type queuedMediaCatalog struct {
	media librarymedia.Media
	err   error
}

func (c queuedMediaCatalog) List(context.Context, string, int) (librarymedia.MediaPage, error) {
	return librarymedia.MediaPage{}, nil
}
func (c queuedMediaCatalog) Browse(context.Context, string, string, int) (librarymedia.FolderPage, error) {
	return librarymedia.FolderPage{}, nil
}
func (c queuedMediaCatalog) Get(context.Context, string) (librarymedia.Media, error) {
	return c.media, c.err
}
func (c queuedMediaCatalog) Refresh(context.Context) error { return nil }
func (c queuedMediaCatalog) Preview(context.Context, preview.PreviewSpec) (preview.TranscodeSpec, error) {
	return preview.TranscodeSpec{}, nil
}

func TestQueuedExecutorValidatesSnapshotAndPersistsResult(t *testing.T) {
	media := librarymedia.Media{ID: "m_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", RootID: "root", ETag: "etag", SizeBytes: 50, DurationMS: 100}
	snapshot := ExportSnapshot{ProjectRevision: 7, MediaLabel: "clip.mkv", Item: model.ProjectItem{ID: "i_aaaaaaaaaaaaaaaaaaaaaaaa", MediaID: media.ID}, Source: SourceSnapshot{MediaID: media.ID, RootID: media.RootID, ETag: media.ETag, SizeBytes: media.SizeBytes, DurationMS: media.DurationMS}}
	payload, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	database, err := store.OpenDatabase(t.Context(), filepath.Join(t.TempDir(), "jobs.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := database.Close(); err != nil {
			t.Error(err)
		}
	})
	jobs, err := testsupport.NewJobsStore(database)
	if err != nil {
		t.Fatal(err)
	}
	job := jobqueue.Job{ID: "j_queuedexport01", BatchID: "b_queuedexport01", Kind: jobqueue.JobExport, ProjectID: "p_queuedexport01", ProjectItemID: "i_aaaaaaaaaaaaaaaaaaaaaaaa", RequestJSON: string(payload)}
	if _, err := jobs.Create(t.Context(), job); err != nil {
		t.Fatal(err)
	}
	if _, err := jobs.Start(t.Context(), job.ID); err != nil {
		t.Fatal(err)
	}
	result := `{"outputName":"clip.mkv","sizeBytes":50}`
	called := false
	queued := QueuedExecutor{
		Jobs: jobs, Media: queuedMediaCatalog{media: media},
		RunSnapshot: func(_ context.Context, id string, got ExportSnapshot) (string, error) {
			called = true
			if id != job.ID || got.ProjectRevision != snapshot.ProjectRevision || got.Item.ExportOptions.Mode != "separate" || got.Item.ExportOptions.Container != "mkv" {
				t.Fatalf("runner input = %q %#v", id, got)
			}
			return result, nil
		},
	}
	if err := queued.Run(t.Context(), job); err != nil {
		t.Fatal(err)
	}
	stored, err := jobs.Get(t.Context(), job.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !called || stored.State != jobqueue.JobSucceeded || !stored.ResultJSON.Valid || stored.ResultJSON.String != result {
		t.Fatalf("queued completion = called %v, state %s, result %#v", called, stored.State, stored.ResultJSON)
	}
}

func TestQueuedExecutorRejectsInvalidOrChangedSnapshotBeforeExecution(t *testing.T) {
	media := librarymedia.Media{ID: "m_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", RootID: "root", ETag: "current", SizeBytes: 50, DurationMS: 100}
	changedSnapshot := ExportSnapshot{Source: SourceSnapshot{MediaID: media.ID, RootID: "root", ETag: "old", SizeBytes: 50, DurationMS: 100}}
	payload, err := json.Marshal(changedSnapshot)
	if err != nil {
		t.Fatal(err)
	}
	called := false
	queued := QueuedExecutor{
		Media: queuedMediaCatalog{media: media},
		RunSnapshot: func(context.Context, string, ExportSnapshot) (string, error) {
			called = true
			return `{}`, nil
		},
	}
	if err := queued.Run(t.Context(), jobqueue.Job{RequestJSON: string(payload)}); !errors.Is(err, jobservice.ErrSourceChanged) || err.Error() != "source_changed" {
		t.Fatalf("changed source error = %v, want source_changed", err)
	}
	if called {
		t.Fatal("runner called for a changed source")
	}
	if err := queued.Run(t.Context(), jobqueue.Job{RequestJSON: "{"}); err == nil || err.Error() != "invalid export snapshot" {
		t.Fatalf("malformed snapshot error = %v", err)
	}
	queued.Media = queuedMediaCatalog{err: errors.New("unavailable")}
	if err := queued.Run(t.Context(), jobqueue.Job{RequestJSON: string(payload)}); !errors.Is(err, jobservice.ErrSourceChanged) {
		t.Fatalf("missing source error = %v, want source_changed", err)
	}
	if called {
		t.Fatal("runner called for a missing source")
	}
}

func TestQueuedExecutorPersistsChangedSourceFailureThroughScheduler(t *testing.T) {
	media := librarymedia.Media{ID: "m_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", ETag: "changed", SizeBytes: 10, DurationMS: 100}
	snapshot := ExportSnapshot{Source: SourceSnapshot{MediaID: media.ID, ETag: "original", SizeBytes: 10, DurationMS: 100}}
	payload, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	database, err := store.OpenDatabase(t.Context(), filepath.Join(t.TempDir(), "jobs.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := database.Close(); err != nil {
			t.Error(err)
		}
	})
	jobs, err := testsupport.NewJobsStore(database)
	if err != nil {
		t.Fatal(err)
	}
	called := false
	queued := QueuedExecutor{Jobs: jobs, Media: queuedMediaCatalog{media: media}, RunSnapshot: func(context.Context, string, ExportSnapshot) (string, error) {
		called = true
		return `{}`, nil
	}}
	scheduler, err := jobservice.NewScheduler(jobs, jobservice.SchedulerConfig{QueueCapacity: 1, WorkerLimit: 1}, queued.Run)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := scheduler.Submit(t.Context(), []jobqueue.Job{{ID: "j_sourcechanged01", BatchID: "b_sourcechanged01", Kind: jobqueue.JobExport, ProjectID: "p_sourcechanged01", ProjectItemID: "i_aaaaaaaaaaaaaaaaaaaaaaaa", RequestJSON: string(payload)}}); err != nil {
		t.Fatal(err)
	}
	scheduler.Start()
	t.Cleanup(func() {
		if err := scheduler.Shutdown(context.Background()); err != nil {
			t.Error(err)
		}
	})
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		job, getErr := jobs.Get(t.Context(), "j_sourcechanged01")
		if getErr == nil && job.State == jobqueue.JobFailed {
			if !job.ErrorCode.Valid || job.ErrorCode.String != "source_changed" || called {
				t.Fatalf("failed source job = %#v; runner called=%v", job, called)
			}
			return
		}
		time.Sleep(time.Millisecond)
	}
	job, getErr := jobs.Get(t.Context(), "j_sourcechanged01")
	t.Fatalf("source job = %#v, %v; want failed source_changed", job, getErr)
}

func TestQueuedExecutorPropagatesRunningCancellation(t *testing.T) {
	media := librarymedia.Media{ID: "m_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", ETag: "etag", SizeBytes: 10, DurationMS: 100}
	snapshot := ExportSnapshot{Source: SourceSnapshot{MediaID: media.ID, ETag: media.ETag, SizeBytes: media.SizeBytes, DurationMS: media.DurationMS}}
	payload, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	database, err := store.OpenDatabase(t.Context(), filepath.Join(t.TempDir(), "jobs.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := database.Close(); err != nil {
			t.Error(err)
		}
	})
	jobs, err := testsupport.NewJobsStore(database)
	if err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{})
	cancelObserved := make(chan struct{})
	queued := QueuedExecutor{Jobs: jobs, Media: queuedMediaCatalog{media: media}, RunSnapshot: func(ctx context.Context, _ string, _ ExportSnapshot) (string, error) {
		close(started)
		<-ctx.Done()
		close(cancelObserved)
		return "", ctx.Err()
	}}
	scheduler, err := jobservice.NewScheduler(jobs, jobservice.SchedulerConfig{QueueCapacity: 1, WorkerLimit: 1}, queued.Run)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := scheduler.Submit(t.Context(), []jobqueue.Job{{ID: "j_cancelqueued01", BatchID: "b_cancelqueued01", Kind: jobqueue.JobExport, ProjectID: "p_cancelqueued01", ProjectItemID: "i_aaaaaaaaaaaaaaaaaaaaaaaa", RequestJSON: string(payload)}}); err != nil {
		t.Fatal(err)
	}
	scheduler.Start()
	t.Cleanup(func() {
		if err := scheduler.Shutdown(context.Background()); err != nil {
			t.Error(err)
		}
	})
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("snapshot runner did not start")
	}
	if _, err := scheduler.Cancel(t.Context(), "j_cancelqueued01"); err != nil {
		t.Fatal(err)
	}
	select {
	case <-cancelObserved:
	case <-time.After(time.Second):
		t.Fatal("snapshot runner did not observe cancellation")
	}
	job, err := jobs.Get(t.Context(), "j_cancelqueued01")
	if err != nil || job.State != jobqueue.JobCancelled {
		t.Fatalf("cancelled queued job = %#v, %v", job, err)
	}
}

func TestValidateSnapshotChecksSourceIdentityAndFingerprint(t *testing.T) {
	snapshot := ExportSnapshot{Source: SourceSnapshot{MediaID: "m_media", RootID: "root-a", ETag: "etag", SizeBytes: 10, DurationMS: 20}}
	matching := librarymedia.Media{ID: "m_media", RootID: "root-a", ETag: "etag", SizeBytes: 10, DurationMS: 20}
	if err := ValidateSnapshot(snapshot, matching); err != nil {
		t.Fatalf("matching source rejected: %v", err)
	}
	for _, changed := range []librarymedia.Media{
		{ID: "m_other", RootID: "root-a", ETag: "etag", SizeBytes: 10, DurationMS: 20},
		{ID: "m_media", RootID: "root-b", ETag: "etag", SizeBytes: 10, DurationMS: 20},
		{ID: "m_media", RootID: "root-a", ETag: "changed", SizeBytes: 10, DurationMS: 20},
		{ID: "m_media", RootID: "root-a", ETag: "etag", SizeBytes: 11, DurationMS: 20},
		{ID: "m_media", RootID: "root-a", ETag: "etag", SizeBytes: 10, DurationMS: 21},
	} {
		if err := ValidateSnapshot(snapshot, changed); !errors.Is(err, jobservice.ErrSourceChanged) {
			t.Errorf("changed source %#v error = %v", changed, err)
		}
	}
}
