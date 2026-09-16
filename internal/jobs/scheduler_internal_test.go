package jobs

import (
	"context"
	"database/sql"
	"errors"
	"math"
	"strconv"
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
	if _, err := db.Exec(`PRAGMA busy_timeout = 5000; CREATE TABLE jobs (id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, kind TEXT NOT NULL, project_id TEXT, project_item_id TEXT, proposal_id TEXT, credential_id TEXT, state TEXT NOT NULL, request_json TEXT NOT NULL, result_json TEXT, error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`); err != nil {
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
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Error(err)
		}
	})
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
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Error(err)
		}
	})
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

func TestSchedulerShutdownBetweenClaimAndRegistrationSkipsRunner(t *testing.T) {
	db := openSchedulerTestDatabase(t)
	defer func() {
		if err := db.Close(); err != nil {
			t.Error(err)
		}
	}()
	jobs, err := NewJobsStore(db)
	if err != nil {
		t.Fatal(err)
	}
	entered, release := make(chan struct{}), make(chan struct{})
	var executions atomic.Int32
	scheduler, err := NewScheduler(jobs, SchedulerConfig{QueueCapacity: 1, WorkerLimit: 1}, func(ctx context.Context, _ Job) error {
		executions.Add(1)
		select {
		case <-ctx.Done():
		case <-t.Context().Done():
		}
		return ctx.Err()
	})
	if err != nil {
		t.Fatal(err)
	}
	scheduler.afterClaim = func() { close(entered); <-release }
	scheduler.Start()
	job := Job{ID: "j_000000000074", BatchID: "b_000000000074", Kind: JobScan, RequestJSON: `{}`}
	if _, err := scheduler.Submit(t.Context(), []Job{job}); err != nil {
		t.Fatal(err)
	}
	<-entered
	ctx, cancel := context.WithTimeout(t.Context(), time.Second)
	defer cancel()
	finished := make(chan error, 1)
	go func() { finished <- scheduler.Shutdown(ctx) }()
	<-scheduler.stop
	close(release)
	if err := <-finished; err != nil {
		t.Fatal(err)
	}
	if executions.Load() != 0 {
		t.Fatal("runner executed a job registered after shutdown")
	}
	stored, err := jobs.Get(t.Context(), job.ID)
	if err != nil || stored.State != JobCancelled {
		t.Fatalf("job = %#v, err = %v", stored, err)
	}
}

func TestSchedulerWorkerLimitSafetyBoundary(t *testing.T) {
	db := openSchedulerTestDatabase(t)
	defer func() {
		if err := db.Close(); err != nil {
			t.Error(err)
		}
	}()
	jobs, _ := NewJobsStore(db)
	for _, limit := range []int{0, 1, 64, 65, math.MaxInt} {
		t.Run(strconv.Itoa(limit), func(t *testing.T) {
			valid := limit >= 1 && limit <= MaxWorkerLimit
			config := SchedulerConfig{QueueCapacity: 4, WorkerLimit: limit}
			s, err := NewScheduler(jobs, config, func(context.Context, Job) error { return nil })
			if (err == nil) != valid {
				t.Fatalf("create(%d) = %v", limit, err)
			}
			if s != nil {
				_ = s.Shutdown(t.Context())
			}
			s, err = NewScheduler(jobs, SchedulerConfig{QueueCapacity: 4, WorkerLimit: 1}, func(context.Context, Job) error { return nil })
			if err != nil {
				t.Fatal(err)
			}
			defer func() {
				if err := s.Shutdown(t.Context()); err != nil {
					t.Error(err)
				}
			}()
			if err := s.SetLimits(config); (err == nil) != valid {
				t.Fatalf("resize(%d) = %v", limit, err)
			}
			if !valid && (s.config.WorkerLimit != 1 || s.workers != 0) {
				t.Fatal("invalid resize mutated scheduler")
			}
		})
	}
}

func TestSchedulerShutdownUnblocksDatabaseClaim(t *testing.T) {
	db := openSchedulerTestDatabase(t)
	defer func() {
		if err := db.Close(); err != nil {
			t.Error(err)
		}
	}()
	jobs, _ := NewJobsStore(db)
	s, err := NewScheduler(jobs, SchedulerConfig{QueueCapacity: 1, WorkerLimit: 1}, func(context.Context, Job) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	connection, err := db.Conn(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := connection.Close(); err != nil {
			t.Error(err)
		}
	}()
	s.Start()
	deadline := time.Now().Add(time.Second)
	for db.Stats().WaitCount == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if db.Stats().WaitCount == 0 {
		t.Fatal("claim did not wait for database connection")
	}
	ctx, cancel := context.WithTimeout(t.Context(), time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- s.Shutdown(ctx) }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal("shutdown blocked on claim despite deadline")
	}
}

func TestSchedulerProposalRemainsIdempotentAfterCapacityDecrease(t *testing.T) {
	db := openSchedulerTestDatabase(t)
	defer func() {
		if err := db.Close(); err != nil {
			t.Error(err)
		}
	}()
	jobs, _ := NewJobsStore(db)
	s, err := NewScheduler(jobs, SchedulerConfig{QueueCapacity: 2, WorkerLimit: 1}, func(context.Context, Job) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := s.Shutdown(t.Context()); err != nil {
			t.Error(err)
		}
	}()
	batch := []Job{
		{ID: "j_000000000081", BatchID: "b_000000000081", Kind: JobExport, ProjectID: "p_project", ProjectItemID: "i_item", ProposalID: "ep_proposal", CredentialID: "c_credential", RequestJSON: `{}`},
		{ID: "j_000000000082", BatchID: "b_000000000081", Kind: JobExport, ProjectID: "p_project", ProjectItemID: "i_item", ProposalID: "ep_proposal", CredentialID: "c_credential", RequestJSON: `{}`},
	}
	if _, err := s.SubmitProposal(t.Context(), "ep_proposal", "c_credential", batch); err != nil {
		t.Fatal(err)
	}
	if err := s.SetLimits(SchedulerConfig{QueueCapacity: 1, WorkerLimit: 1}); err != nil {
		t.Fatal(err)
	}
	if got, err := s.SubmitProposal(t.Context(), "ep_proposal", "c_credential", batch); err != nil || len(got) != 2 {
		t.Fatalf("repeated proposal = %v, %v", got, err)
	}
	batch[0].ProposalID = "ep_other"
	if _, err := s.SubmitProposal(t.Context(), "ep_other", "c_credential", batch[:1]); !errors.Is(err, ErrQueueFull) {
		t.Fatalf("new admission = %v", err)
	}
}

func TestSchedulerCancellationAfterRunnerReturnPersistsBeforeSuccess(t *testing.T) {
	db := openSchedulerTestDatabase(t)
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Error(err)
		}
	})
	jobs, err := NewJobsStore(db)
	if err != nil {
		t.Fatal(err)
	}
	deregistered := make(chan struct{})
	release := make(chan struct{})
	scheduler, err := NewScheduler(jobs, SchedulerConfig{QueueCapacity: 1, WorkerLimit: 1}, func(context.Context, Job) error {
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	scheduler.afterDeregister = func() {
		close(deregistered)
		<-release
	}
	scheduler.Start()
	job := Job{ID: "j_000000000093", BatchID: "b_000000000093", Kind: JobScan, RequestJSON: `{}`}
	if _, err := scheduler.Submit(t.Context(), []Job{job}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-deregistered:
	case <-time.After(time.Second):
		t.Fatal("runner did not reach the deregistration barrier")
	}
	cancelled := make(chan struct {
		job Job
		err error
	}, 1)
	go func() {
		value, err := scheduler.Cancel(t.Context(), job.ID)
		cancelled <- struct {
			job Job
			err error
		}{job: value, err: err}
	}()
	select {
	case result := <-cancelled:
		if result.err != nil || result.job.State != JobCancelled {
			t.Fatalf("cancellation = %#v, %v; want durable cancellation", result.job, result.err)
		}
	case <-time.After(time.Second):
		t.Fatal("cancellation did not acknowledge while worker was at the barrier")
	}
	stored, err := jobs.Get(t.Context(), job.ID)
	if err != nil || stored.State != JobCancelled {
		t.Fatalf("stored job before worker release = %#v, %v", stored, err)
	}
	close(release)
	if err := scheduler.Shutdown(t.Context()); err != nil {
		t.Fatal(err)
	}
	stored, err = jobs.Get(t.Context(), job.ID)
	if err != nil || stored.State != JobCancelled {
		t.Fatalf("stored job after worker release = %#v, %v", stored, err)
	}
}

func TestSchedulerCancellationArbitratesRunnerSuccessBothOrders(t *testing.T) {
	for _, test := range []struct {
		name        string
		cancelFirst bool
	}{
		{name: "cancellation_wins", cancelFirst: true},
		{name: "success_wins", cancelFirst: false},
	} {
		t.Run(test.name, func(t *testing.T) {
			database := openSchedulerTestDatabase(t)
			t.Cleanup(func() {
				if err := database.Close(); err != nil {
					t.Error(err)
				}
			})
			jobs, err := NewJobsStore(database)
			if err != nil {
				t.Fatal(err)
			}
			started := make(chan struct{})
			succeedAttempted := make(chan error, 1)
			release := make(chan struct{})
			var releaseOnce sync.Once
			releaseRunner := func() { releaseOnce.Do(func() { close(release) }) }
			scheduler, err := NewScheduler(jobs, SchedulerConfig{QueueCapacity: 1, WorkerLimit: 1}, func(ctx context.Context, job Job) error {
				close(started)
				if test.cancelFirst {
					<-ctx.Done()
				}
				_, err := jobs.Succeed(context.Background(), job.ID, `{"output":"published"}`)
				succeedAttempted <- err
				if !test.cancelFirst {
					<-release
				}
				return err
			})
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() {
				releaseRunner()
				if err := scheduler.Shutdown(context.Background()); err != nil {
					t.Error(err)
				}
			})
			job := Job{ID: "j_000000000094", BatchID: "b_000000000094", Kind: JobScan, RequestJSON: `{}`}
			if _, err := scheduler.Submit(t.Context(), []Job{job}); err != nil {
				t.Fatal(err)
			}
			scheduler.Start()
			<-started
			if test.cancelFirst {
				cancelled, err := scheduler.Cancel(t.Context(), job.ID)
				if err != nil || cancelled.State != JobCancelled {
					t.Fatalf("cancellation = %#v, %v", cancelled, err)
				}
				if err := <-succeedAttempted; !errors.Is(err, ErrJobState) {
					t.Fatalf("runner success after cancellation = %v", err)
				}
			} else {
				if err := <-succeedAttempted; err != nil {
					t.Fatalf("runner success = %v", err)
				}
				if _, err := scheduler.Cancel(t.Context(), job.ID); !errors.Is(err, ErrJobState) {
					t.Fatalf("cancellation after success = %v", err)
				}
				releaseRunner()
			}
			if err := scheduler.Shutdown(t.Context()); err != nil {
				t.Fatal(err)
			}
			stored, err := jobs.Get(t.Context(), job.ID)
			if err != nil {
				t.Fatal(err)
			}
			if test.cancelFirst {
				if stored.State != JobCancelled {
					t.Fatalf("stored cancelled job = %#v", stored)
				}
			} else if stored.State != JobSucceeded || !stored.ResultJSON.Valid || stored.ResultJSON.String != `{"output":"published"}` {
				t.Fatalf("stored successful job = %#v", stored)
			}
		})
	}
}

func TestSchedulerAdmissionReturnsCommittedJobsAfterContextCancellation(t *testing.T) {
	tests := []struct {
		name   string
		jobs   []Job
		submit func(*Scheduler, context.Context, []Job) ([]Job, error)
	}{
		{
			name: "batch",
			jobs: []Job{{ID: "j_000000000091", BatchID: "b_000000000091", Kind: JobScan, RequestJSON: `{}`}},
			submit: func(s *Scheduler, ctx context.Context, jobs []Job) ([]Job, error) {
				return s.Submit(ctx, jobs)
			},
		},
		{
			name: "proposal",
			jobs: []Job{{ID: "j_000000000092", BatchID: "b_000000000092", Kind: JobExport, ProjectID: "p_project", ProjectItemID: "i_item", ProposalID: "ep_proposal", CredentialID: "c_credential", RequestJSON: `{}`}},
			submit: func(s *Scheduler, ctx context.Context, jobs []Job) ([]Job, error) {
				return s.SubmitProposal(ctx, "ep_proposal", "c_credential", jobs)
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			database := openSchedulerTestDatabase(t)
			t.Cleanup(func() {
				if err := database.Close(); err != nil {
					t.Error(err)
				}
			})
			jobs, err := NewJobsStore(database)
			if err != nil {
				t.Fatal(err)
			}
			scheduler, err := NewScheduler(jobs, SchedulerConfig{QueueCapacity: 1, WorkerLimit: 1}, func(context.Context, Job) error { return nil })
			if err != nil {
				t.Fatal(err)
			}
			defer func() {
				if err := scheduler.Shutdown(t.Context()); err != nil {
					t.Error(err)
				}
			}()
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			scheduler.afterCommit = cancel
			got, err := test.submit(scheduler, ctx, test.jobs)
			if err != nil {
				t.Fatalf("submit after commit cancellation = %v", err)
			}
			if len(got) != len(test.jobs) {
				t.Fatalf("returned %d jobs, want %d", len(got), len(test.jobs))
			}
			for i, returned := range got {
				if returned.ID != test.jobs[i].ID || returned.State != JobQueued || returned.CreatedAt.IsZero() || returned.UpdatedAt.IsZero() {
					t.Fatalf("returned job %d = %#v", i, returned)
				}
				stored, err := jobs.Get(t.Context(), returned.ID)
				if err != nil {
					t.Fatal(err)
				}
				if stored.State != JobQueued || !stored.CreatedAt.Equal(returned.CreatedAt) || !stored.UpdatedAt.Equal(returned.UpdatedAt) {
					t.Fatalf("stored job %d = %#v, returned = %#v", i, stored, returned)
				}
			}
		})
	}
}
