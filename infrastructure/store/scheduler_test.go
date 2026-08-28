package store_test

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"videocutlist/infrastructure/store"
)

func schedulerJob(n string) store.Job {
	return store.Job{ID: "j_0000000000" + n, BatchID: "b_0000000000" + n, Kind: store.JobScan, RequestJSON: `{}`}
}

func TestSchedulerAdmissionIsAtomicAndBounded(t *testing.T) {
	db, err := store.OpenDatabase(context.Background(), t.TempDir()+"/jobs.db")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	jobs, _ := store.NewJobsStore(db)
	s, err := store.NewScheduler(jobs, store.SchedulerConfig{QueueCapacity: 2, WorkerLimit: 1}, func(context.Context, store.Job) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Submit(context.Background(), []store.Job{schedulerJob("01"), schedulerJob("02")}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Submit(context.Background(), []store.Job{schedulerJob("03")}); !errors.Is(err, store.ErrQueueFull) {
		t.Fatalf("full = %v", err)
	}
	if _, err := jobs.Get(context.Background(), "j_000000000003"); !errors.Is(err, store.ErrJobNotFound) {
		t.Fatalf("rejected job exists: %v", err)
	}
}

func TestSchedulerBoundedExecutionCancellationAndShutdown(t *testing.T) {
	db, err := store.OpenDatabase(context.Background(), t.TempDir()+"/jobs.db")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	jobs, _ := store.NewJobsStore(db)
	started := make(chan string, 2)
	release := make(chan struct{})
	var mu sync.Mutex
	running, maxRunning := 0, 0
	s, err := store.NewScheduler(jobs, store.SchedulerConfig{QueueCapacity: 3, WorkerLimit: 1}, func(ctx context.Context, job store.Job) error {
		mu.Lock()
		running++
		if running > maxRunning {
			maxRunning = running
		}
		mu.Unlock()
		started <- job.ID
		select {
		case <-release:
		case <-ctx.Done():
		}
		mu.Lock()
		running--
		mu.Unlock()
		return ctx.Err()
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Submit(context.Background(), []store.Job{schedulerJob("11"), schedulerJob("12")}); err != nil {
		t.Fatal(err)
	}
	s.Start()
	first := <-started
	if _, err := s.Cancel(context.Background(), first); err != nil {
		t.Fatal(err)
	}
	close(release)
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		second, err := jobs.Get(context.Background(), "j_000000000012")
		if err == nil && second.State == store.JobSucceeded {
			break
		}
		time.Sleep(time.Millisecond)
	}
	second, err := jobs.Get(context.Background(), "j_000000000012")
	if err != nil || second.State != store.JobSucceeded {
		t.Fatalf("second = %#v, %v", second, err)
	}
	mu.Lock()
	gotMax := maxRunning
	mu.Unlock()
	if gotMax != 1 {
		t.Fatalf("max running = %d", gotMax)
	}
	if err := s.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestSchedulerLeavesQueuedAndRecoversRunningOnRestart(t *testing.T) {
	db, err := store.OpenDatabase(context.Background(), t.TempDir()+"/jobs.db")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	jobs, _ := store.NewJobsStore(db)
	s, err := store.NewScheduler(jobs, store.SchedulerConfig{QueueCapacity: 2, WorkerLimit: 1}, func(context.Context, store.Job) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Submit(context.Background(), []store.Job{schedulerJob("21"), schedulerJob("22")}); err != nil {
		t.Fatal(err)
	}
	if _, err := jobs.Start(context.Background(), "j_000000000021"); err != nil {
		t.Fatal(err)
	}
	if _, err := jobs.Recover(context.Background()); err != nil {
		t.Fatal(err)
	}
	running, _ := jobs.Get(context.Background(), "j_000000000021")
	queued, _ := jobs.Get(context.Background(), "j_000000000022")
	if running.State != store.JobFailed || !running.ErrorCode.Valid || running.ErrorCode.String != "interrupted_by_restart" || queued.State != store.JobQueued {
		t.Fatalf("recovery = %#v queued = %#v", running, queued)
	}
}
