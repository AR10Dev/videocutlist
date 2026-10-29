package jobs

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"
	store "videocutlist/internal/db"
	"videocutlist/internal/jobs/model"
)

func TestSchedulerAdmissionCancellationAndShutdown(t *testing.T) {
	db, err := store.OpenDatabase(t.Context(), filepath.Join(t.TempDir(), "jobs.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	storage, err := store.NewJobStorage(db)
	if err != nil {
		t.Fatal(err)
	}
	jobs, err := NewJobsStore(storage)
	if err != nil {
		t.Fatal(err)
	}
	scheduler, err := NewScheduler(jobs, SchedulerConfig{QueueCapacity: 1, WorkerLimit: 1}, func(context.Context, model.Job) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := scheduler.Shutdown(ctx); err != nil {
			t.Error(err)
		}
	})
	first := model.Job{ID: "j_aaaaaaaaaaaa", BatchID: "b_aaaaaaaaaaaa", Kind: model.JobScan, RequestJSON: "{}"}
	if _, err := scheduler.Submit(t.Context(), []model.Job{first}); err != nil {
		t.Fatal(err)
	}
	second := first
	second.ID, second.BatchID = "j_bbbbbbbbbbbb", "b_bbbbbbbbbbbb"
	if _, err := scheduler.Submit(t.Context(), []model.Job{second}); !errors.Is(err, model.ErrQueueFull) {
		t.Fatalf("full queue: %v", err)
	}
	if _, err := jobs.Get(t.Context(), second.ID); !errors.Is(err, model.ErrJobNotFound) {
		t.Fatalf("rejected admission persisted: %v", err)
	}
	if cancelled, err := scheduler.Cancel(t.Context(), first.ID); err != nil || cancelled.State != model.JobCancelled {
		t.Fatalf("cancel = %#v, %v", cancelled, err)
	}
	if _, err := scheduler.Submit(t.Context(), []model.Job{second}); err != nil {
		t.Fatal(err)
	}
	scheduler.Start()
	deadline := time.NewTimer(5 * time.Second)
	defer deadline.Stop()
	for {
		job, err := jobs.Get(t.Context(), second.ID)
		if err != nil {
			t.Fatal(err)
		}
		if job.State == model.JobSucceeded {
			break
		}
		select {
		case <-deadline.C:
			t.Fatalf("job did not complete: %#v", job)
		case <-time.After(10 * time.Millisecond):
		}
	}
	if err := scheduler.Shutdown(t.Context()); err != nil {
		t.Fatal(err)
	}
	if _, err := scheduler.Submit(t.Context(), []model.Job{first}); !errors.Is(err, ErrSchedulerStopped) {
		t.Fatalf("submit after shutdown: %v", err)
	}
}
