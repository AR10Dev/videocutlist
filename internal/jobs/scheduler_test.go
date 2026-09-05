package jobs_test

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	db "videocutlist/internal/db"
	store "videocutlist/internal/jobs"
)

func schedulerJob(n string) store.Job {
	return store.Job{ID: "j_0000000000" + n, BatchID: "b_0000000000" + n, Kind: store.JobScan, RequestJSON: `{}`}
}

func TestSchedulerPreservesRunnerResult(t *testing.T) {
	ctx := context.Background()
	db, err := db.OpenDatabase(ctx, t.TempDir()+"/jobs.db")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	jobs, err := store.NewJobsStore(db)
	if err != nil {
		t.Fatal(err)
	}
	result := `{"camera":{"state":"ready_with_media"}}`
	s, err := store.NewScheduler(jobs, store.SchedulerConfig{QueueCapacity: 1, WorkerLimit: 1}, func(ctx context.Context, job store.Job) error {
		_, err := jobs.Succeed(ctx, job.ID, result)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Submit(ctx, []store.Job{schedulerJob("00")}); err != nil {
		t.Fatal(err)
	}
	s.Start()
	defer s.Shutdown(ctx)
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		job, err := jobs.Get(ctx, "j_000000000000")
		if err == nil && job.State == store.JobSucceeded {
			if !job.ResultJSON.Valid || job.ResultJSON.String != result {
				t.Fatalf("result = %#v", job.ResultJSON)
			}
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("scheduled job did not complete")
}

func TestSchedulerAdmissionIsAtomicAndBounded(t *testing.T) {
	db, err := db.OpenDatabase(context.Background(), t.TempDir()+"/jobs.db")
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
	db, err := db.OpenDatabase(context.Background(), t.TempDir()+"/jobs.db")
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

func TestSchedulerQueuedCancellationNeverInvokesRunner(t *testing.T) {
	db, err := db.OpenDatabase(context.Background(), t.TempDir()+"/jobs.db")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	jobs, _ := store.NewJobsStore(db)
	var executions atomic.Int32
	s, err := store.NewScheduler(jobs, store.SchedulerConfig{QueueCapacity: 1, WorkerLimit: 1}, func(context.Context, store.Job) error {
		executions.Add(1)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Submit(context.Background(), []store.Job{schedulerJob("31")}); err != nil {
		t.Fatal(err)
	}
	cancelled, err := s.Cancel(context.Background(), "j_000000000031")
	if err != nil || cancelled.State != store.JobCancelled {
		t.Fatalf("cancelled = %#v, %v", cancelled, err)
	}
	s.Start()
	if err := s.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
	if executions.Load() != 0 {
		t.Fatalf("runner executed cancelled job %d times", executions.Load())
	}
}

func TestSchedulerRunningCancellationWaitsForRunnerTerminalState(t *testing.T) {
	db, err := db.OpenDatabase(context.Background(), t.TempDir()+"/jobs.db")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	jobs, _ := store.NewJobsStore(db)
	started := make(chan struct{})
	returned := make(chan struct{})
	s, err := store.NewScheduler(jobs, store.SchedulerConfig{QueueCapacity: 1, WorkerLimit: 1}, func(ctx context.Context, _ store.Job) error {
		close(started)
		<-ctx.Done()
		<-returned
		return ctx.Err()
	})
	if err != nil {
		t.Fatal(err)
	}
	s.Start()
	if _, err := s.Submit(context.Background(), []store.Job{schedulerJob("32")}); err != nil {
		t.Fatal(err)
	}
	<-started
	cancelled, err := s.Cancel(context.Background(), "j_000000000032")
	if err != nil || cancelled.State != store.JobRunning {
		t.Fatalf("running cancellation = %#v, %v", cancelled, err)
	}
	current, err := jobs.Get(context.Background(), "j_000000000032")
	if err != nil || current.State != store.JobRunning {
		t.Fatalf("job terminalized before runner returned: %#v, %v", current, err)
	}
	close(returned)
	waitForJobState(t, jobs, "j_000000000032", store.JobCancelled)
	if err := s.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestSchedulerConcurrentSubmitClaimAndCancel(t *testing.T) {
	db, err := db.OpenDatabase(t.Context(), t.TempDir()+"/jobs.db")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	jobs, _ := store.NewJobsStore(db)
	s, err := store.NewScheduler(jobs, store.SchedulerConfig{QueueCapacity: 32, WorkerLimit: 2}, func(ctx context.Context, _ store.Job) error {
		<-ctx.Done()
		return ctx.Err()
	})
	if err != nil {
		t.Fatal(err)
	}
	s.Start()
	var wg sync.WaitGroup
	for i := range 16 {
		job := schedulerJob(fmt.Sprintf("%02d", 50+i))
		wg.Go(func() {
			if _, err := s.Submit(t.Context(), []store.Job{job}); err == nil {
				_, _ = s.Cancel(t.Context(), job.ID)
			}
		})
	}
	wg.Wait()
	if err := s.Shutdown(t.Context()); err != nil {
		t.Fatal(err)
	}
}

func waitForJobState(t *testing.T, jobs *store.JobsStore, id string, want store.JobState) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		job, err := jobs.Get(context.Background(), id)
		if err == nil && job.State == want {
			return
		}
		time.Sleep(time.Millisecond)
	}
	job, err := jobs.Get(context.Background(), id)
	t.Fatalf("job state = %#v, %v; want %s", job, err, want)
}

func TestSchedulerStartAndShutdownAreIdempotent(t *testing.T) {
	db, err := db.OpenDatabase(context.Background(), t.TempDir()+"/jobs.db")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	jobs, _ := store.NewJobsStore(db)
	started := make(chan struct{}, 3)
	release := make(chan struct{})
	s, err := store.NewScheduler(jobs, store.SchedulerConfig{QueueCapacity: 3, WorkerLimit: 2}, func(ctx context.Context, _ store.Job) error {
		started <- struct{}{}
		select {
		case <-release:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	s.Start()
	s.Start()
	if _, err := s.Submit(context.Background(), []store.Job{schedulerJob("41"), schedulerJob("42"), schedulerJob("43")}); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		select {
		case <-started:
		case <-time.After(time.Second):
			t.Fatal("expected bounded workers to start")
		}
	}
	select {
	case <-started:
		t.Fatal("Start created more than the configured workers")
	case <-time.After(25 * time.Millisecond):
	}
	close(release)
	if err := s.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := s.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
	s.Start()
}

func TestSchedulerLeavesQueuedAndRecoversRunningOnRestart(t *testing.T) {
	db, err := db.OpenDatabase(context.Background(), t.TempDir()+"/jobs.db")
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
