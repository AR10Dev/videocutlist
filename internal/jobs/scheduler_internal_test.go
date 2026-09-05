package jobs

import (
	"context"
	"database/sql"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	_ "modernc.org/sqlite"
)

func openSchedulerTestDatabase(t *testing.T) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite", t.TempDir()+"/jobs.db")
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(`PRAGMA busy_timeout = 5000; CREATE TABLE jobs (id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, kind TEXT NOT NULL, project_id TEXT, project_item_id TEXT, state TEXT NOT NULL, request_json TEXT NOT NULL, result_json TEXT, error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`); err != nil {
		t.Fatal(err)
	}
	return db
}

func TestSchedulerCancelBetweenClaimAndRegistrationSkipsRunner(t *testing.T) {
	db := openSchedulerTestDatabase(t)
	var err error
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	jobs, err := NewJobsStore(db)
	if err != nil {
		t.Fatal(err)
	}
	entered := make(chan struct{})
	release := make(chan struct{})
	var executions atomic.Int32
	scheduler, err := NewScheduler(jobs, SchedulerConfig{QueueCapacity: 1, WorkerLimit: 1}, func(context.Context, Job) error {
		executions.Add(1)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	scheduler.afterClaim = func() {
		close(entered)
		<-release
	}
	scheduler.Start()
	job := Job{ID: "j_000000000071", BatchID: "b_000000000071", Kind: JobScan, RequestJSON: `{}`}
	if _, err := scheduler.Submit(context.Background(), []Job{job}); err != nil {
		t.Fatal(err)
	}
	<-entered
	cancelled := make(chan error, 1)
	go func() {
		_, err := scheduler.Cancel(context.Background(), job.ID)
		cancelled <- err
	}()
	select {
	case err := <-cancelled:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("cancellation did not complete at the claim-to-registration barrier")
	}
	close(release)
	if err := scheduler.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
	if executions.Load() != 0 {
		t.Fatalf("runner executed cancelled job %d times", executions.Load())
	}
	stored, err := jobs.Get(context.Background(), job.ID)
	if err != nil || stored.State != JobCancelled {
		t.Fatalf("job = %#v, err = %v", stored, err)
	}
}

func TestSchedulerConcurrentSubmitClaimAndCancel(t *testing.T) {
	db := openSchedulerTestDatabase(t)
	var err error
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	jobs, err := NewJobsStore(db)
	if err != nil {
		t.Fatal(err)
	}
	entered := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	var executions atomic.Int32
	scheduler, err := NewScheduler(jobs, SchedulerConfig{QueueCapacity: 2, WorkerLimit: 1}, func(context.Context, Job) error {
		executions.Add(1)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	scheduler.afterClaim = func() {
		once.Do(func() {
			close(entered)
			<-release
		})
	}
	scheduler.Start()
	first := Job{ID: "j_000000000072", BatchID: "b_000000000072", Kind: JobScan, RequestJSON: `{}`}
	second := Job{ID: "j_000000000073", BatchID: "b_000000000073", Kind: JobScan, RequestJSON: `{}`}
	if _, err := scheduler.Submit(t.Context(), []Job{first}); err != nil {
		t.Fatal(err)
	}
	<-entered
	var group sync.WaitGroup
	errs := make(chan error, 2)
	group.Go(func() {
		_, err := scheduler.Cancel(t.Context(), first.ID)
		errs <- err
	})
	group.Go(func() {
		_, err := scheduler.Submit(t.Context(), []Job{second})
		errs <- err
	})
	group.Wait()
	close(errs)
	close(release)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		stored, err := jobs.Get(t.Context(), second.ID)
		if err == nil && stored.State == JobSucceeded {
			break
		}
		time.Sleep(time.Millisecond)
	}
	if err := scheduler.Shutdown(t.Context()); err != nil {
		t.Fatal(err)
	}
	firstStored, err := jobs.Get(t.Context(), first.ID)
	if err != nil || firstStored.State != JobCancelled {
		t.Fatalf("first = %#v, err = %v", firstStored, err)
	}
	secondStored, err := jobs.Get(t.Context(), second.ID)
	if err != nil || secondStored.State != JobSucceeded {
		t.Fatalf("second = %#v, err = %v", secondStored, err)
	}
	if executions.Load() != 1 {
		t.Fatalf("executions = %d", executions.Load())
	}
}
