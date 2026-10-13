package jobs

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log"
	"math"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"videocutlist/internal/jobs/model"
	settingsmodel "videocutlist/internal/settings/model"

	_ "modernc.org/sqlite"
)

func TestSchedulerClaimReportsEmptyQueueWithoutStorageErrors(t *testing.T) {
	database := openSchedulerTestDatabase(t)
	t.Cleanup(func() {
		if err := database.Close(); err != nil {
			t.Error(err)
		}
	})
	jobs, err := newTestJobsStore(database)
	if err != nil {
		t.Fatal(err)
	}
	scheduler, err := NewScheduler(jobs, SchedulerConfig{QueueCapacity: 1, WorkerLimit: 1}, func(context.Context, model.Job) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	if _, err := scheduler.claim(t.Context()); !errors.Is(err, model.ErrNoQueuedJob) {
		t.Fatalf("empty queue claim = %v, want model.ErrNoQueuedJob", err)
	}
}

func TestSchedulerClaimAdvancesJobRevision(t *testing.T) {
	database := openSchedulerTestDatabase(t)
	t.Cleanup(func() {
		if err := database.Close(); err != nil {
			t.Error(err)
		}
	})
	jobs, err := newTestJobsStore(database)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := jobs.Create(t.Context(), model.Job{ID: "j_claimrevision1", BatchID: "b_claimrevision1", Kind: model.JobScan, RequestJSON: `{}`}); err != nil {
		t.Fatal(err)
	}
	scheduler, err := NewScheduler(jobs, SchedulerConfig{QueueCapacity: 1, WorkerLimit: 1}, func(context.Context, model.Job) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	claimed, err := scheduler.claim(t.Context())
	if err != nil || claimed.Revision != 2 {
		t.Fatalf("claimed job revision = %d, %v", claimed.Revision, err)
	}
}

func waitForJobState(t *testing.T, jobs *JobsStore, id string, want model.JobState) {
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
	t.Fatalf("small internal state = %#v, %v; want %s", job, err, want)
}

func openSchedulerTestDatabase(t *testing.T) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite", t.TempDir()+"/jobs.db")
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(`PRAGMA busy_timeout = 5000; CREATE TABLE jobs (id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, kind TEXT NOT NULL, project_id TEXT, project_item_id TEXT, proposal_id TEXT, credential_id TEXT, state TEXT NOT NULL, request_json TEXT NOT NULL, result_json TEXT, error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1)`); err != nil {
		t.Fatal(err)
	}
	return db
}

type synchronizedBuffer struct {
	mu sync.Mutex
	bytes.Buffer
}

func (b *synchronizedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.Buffer.Write(p)
}

func (b *synchronizedBuffer) Bytes() []byte {
	b.mu.Lock()
	defer b.mu.Unlock()
	return bytes.Clone(b.Buffer.Bytes())
}

func (b *synchronizedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.Buffer.String()
}

func (b *synchronizedBuffer) Len() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.Buffer.Len()
}

func TestSchedulerCancelBetweenClaimAndRegistrationSkipsRunner(t *testing.T) {
	db := openSchedulerTestDatabase(t)
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Error(err)
		}
	})
	jobs, err := newTestJobsStore(db)
	if err != nil {
		t.Fatal(err)
	}
	entered := make(chan struct{})
	release := make(chan struct{})
	var executions atomic.Int32
	scheduler, err := NewScheduler(jobs, SchedulerConfig{QueueCapacity: 1, WorkerLimit: 1}, func(context.Context, model.Job) error {
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
	job := model.Job{ID: "j_000000000071", BatchID: "b_000000000071", Kind: model.JobScan, RequestJSON: `{}`}
	if _, err := scheduler.Submit(context.Background(), []model.Job{job}); err != nil {
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
	if err != nil || stored.State != model.JobCancelled {
		t.Fatalf("job = %#v, err = %v", stored, err)
	}
}

func TestSchedulerConcurrentSubmitClaimAndCancel(t *testing.T) {
	db := openSchedulerTestDatabase(t)
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Error(err)
		}
	})
	jobs, err := newTestJobsStore(db)
	if err != nil {
		t.Fatal(err)
	}
	entered := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	var executions atomic.Int32
	scheduler, err := NewScheduler(jobs, SchedulerConfig{QueueCapacity: 2, WorkerLimit: 1}, func(context.Context, model.Job) error {
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
	first := model.Job{ID: "j_000000000072", BatchID: "b_000000000072", Kind: model.JobScan, RequestJSON: `{}`}
	second := model.Job{ID: "j_000000000073", BatchID: "b_000000000073", Kind: model.JobScan, RequestJSON: `{}`}
	if _, err := scheduler.Submit(t.Context(), []model.Job{first}); err != nil {
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
		_, err := scheduler.Submit(t.Context(), []model.Job{second})
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
		if err == nil && stored.State == model.JobSucceeded {
			break
		}
		time.Sleep(time.Millisecond)
	}
	if err := scheduler.Shutdown(t.Context()); err != nil {
		t.Fatal(err)
	}
	firstStored, err := jobs.Get(t.Context(), first.ID)
	if err != nil || firstStored.State != model.JobCancelled {
		t.Fatalf("first = %#v, err = %v", firstStored, err)
	}
	secondStored, err := jobs.Get(t.Context(), second.ID)
	if err != nil || secondStored.State != model.JobSucceeded {
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
	jobs, err := newTestJobsStore(db)
	if err != nil {
		t.Fatal(err)
	}
	entered, release := make(chan struct{}), make(chan struct{})
	var executions atomic.Int32
	scheduler, err := NewScheduler(jobs, SchedulerConfig{QueueCapacity: 1, WorkerLimit: 1}, func(ctx context.Context, _ model.Job) error {
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
	job := model.Job{ID: "j_000000000074", BatchID: "b_000000000074", Kind: model.JobScan, RequestJSON: `{}`}
	if _, err := scheduler.Submit(t.Context(), []model.Job{job}); err != nil {
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
	if err != nil || stored.State != model.JobFailed || stored.ErrorCode.String != "interrupted_by_restart" {
		t.Fatalf("job = %#v, err = %v", stored, err)
	}
}

func TestSchedulerShutdownPreservesQueuedAndFailsInterruptedWork(t *testing.T) {
	db := openSchedulerTestDatabase(t)
	t.Cleanup(func() { _ = db.Close() })
	jobs, err := newTestJobsStore(db)
	if err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{})
	scheduler, err := NewScheduler(jobs, SchedulerConfig{QueueCapacity: 2, WorkerLimit: 1}, func(ctx context.Context, _ model.Job) error {
		close(started)
		<-ctx.Done()
		return ctx.Err()
	})
	if err != nil {
		t.Fatal(err)
	}
	first := model.Job{ID: "j_shutdown_active", BatchID: "b_shutdown_batch", Kind: model.JobScan, RequestJSON: `{}`}
	second := model.Job{ID: "j_shutdown_queued", BatchID: "b_shutdown_batch", Kind: model.JobScan, RequestJSON: `{}`}
	if _, err := scheduler.Submit(t.Context(), []model.Job{first, second}); err != nil {
		t.Fatal(err)
	}
	scheduler.Start()
	<-started
	ctx, cancel := context.WithTimeout(t.Context(), time.Second)
	defer cancel()
	if err := scheduler.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
	active, err := jobs.Get(t.Context(), first.ID)
	if err != nil || active.State != model.JobFailed || active.ErrorCode.String != "interrupted_by_restart" {
		t.Fatalf("interrupted work = %#v, %v", active, err)
	}
	queued, err := jobs.Get(t.Context(), second.ID)
	if err != nil || queued.State != model.JobQueued {
		t.Fatalf("queued work = %#v, %v", queued, err)
	}
	if recovered, err := jobs.Recover(t.Context()); err != nil || recovered != 0 {
		t.Fatalf("already finalized interruption recovered again: %d, %v", recovered, err)
	}
}

func TestSchedulerWorkerLimitSafetyBoundary(t *testing.T) {
	db := openSchedulerTestDatabase(t)
	defer func() {
		if err := db.Close(); err != nil {
			t.Error(err)
		}
	}()
	jobs, _ := newTestJobsStore(db)
	for _, limit := range []int{0, 1, 64, 65, math.MaxInt} {
		t.Run(strconv.Itoa(limit), func(t *testing.T) {
			valid := limit >= 1 && limit <= settingsmodel.MaxExportWorkers
			config := SchedulerConfig{QueueCapacity: 4, WorkerLimit: limit}
			s, err := NewScheduler(jobs, config, func(context.Context, model.Job) error { return nil })
			if (err == nil) != valid {
				t.Fatalf("create(%d) = %v", limit, err)
			}
			if s != nil {
				_ = s.Shutdown(t.Context())
			}
			s, err = NewScheduler(jobs, SchedulerConfig{QueueCapacity: 4, WorkerLimit: 1}, func(context.Context, model.Job) error { return nil })
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
	jobs, _ := newTestJobsStore(db)
	s, err := NewScheduler(jobs, SchedulerConfig{QueueCapacity: 1, WorkerLimit: 1}, func(context.Context, model.Job) error { return nil })
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
	jobs, _ := newTestJobsStore(db)
	s, err := NewScheduler(jobs, SchedulerConfig{QueueCapacity: 2, WorkerLimit: 1}, func(context.Context, model.Job) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := s.Shutdown(t.Context()); err != nil {
			t.Error(err)
		}
	}()
	batch := []model.Job{
		{ID: "j_000000000081", BatchID: "b_000000000081", Kind: model.JobExport, ProjectID: "p_project", ProjectItemID: "i_item", ProposalID: "ep_proposal", CredentialID: "c_credential", RequestJSON: `{}`},
		{ID: "j_000000000082", BatchID: "b_000000000081", Kind: model.JobExport, ProjectID: "p_project", ProjectItemID: "i_item", ProposalID: "ep_proposal", CredentialID: "c_credential", RequestJSON: `{}`},
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
	if _, err := s.SubmitProposal(t.Context(), "ep_other", "c_credential", batch[:1]); !errors.Is(err, model.ErrQueueFull) {
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
	jobs, err := newTestJobsStore(db)
	if err != nil {
		t.Fatal(err)
	}
	deregistered := make(chan struct{})
	release := make(chan struct{})
	scheduler, err := NewScheduler(jobs, SchedulerConfig{QueueCapacity: 1, WorkerLimit: 1}, func(context.Context, model.Job) error {
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
	job := model.Job{ID: "j_000000000093", BatchID: "b_000000000093", Kind: model.JobScan, RequestJSON: `{}`}
	if _, err := scheduler.Submit(t.Context(), []model.Job{job}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-deregistered:
	case <-time.After(time.Second):
		t.Fatal("runner did not reach the deregistration barrier")
	}
	cancelled := make(chan struct {
		job model.Job
		err error
	}, 1)
	go func() {
		value, err := scheduler.Cancel(t.Context(), job.ID)
		cancelled <- struct {
			job model.Job
			err error
		}{job: value, err: err}
	}()
	select {
	case result := <-cancelled:
		if result.err != nil || result.job.State != model.JobCancelled {
			t.Fatalf("cancellation = %#v, %v; want durable cancellation", result.job, result.err)
		}
	case <-time.After(time.Second):
		t.Fatal("cancellation did not acknowledge while worker was at the barrier")
	}
	stored, err := jobs.Get(t.Context(), job.ID)
	if err != nil || stored.State != model.JobCancelled {
		t.Fatalf("stored job before worker release = %#v, %v", stored, err)
	}
	close(release)
	if err := scheduler.Shutdown(t.Context()); err != nil {
		t.Fatal(err)
	}
	stored, err = jobs.Get(t.Context(), job.ID)
	if err != nil || stored.State != model.JobCancelled {
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
			jobs, err := newTestJobsStore(database)
			if err != nil {
				t.Fatal(err)
			}
			started := make(chan struct{})
			succeedAttempted := make(chan error, 1)
			release := make(chan struct{})
			var releaseOnce sync.Once
			releaseRunner := func() { releaseOnce.Do(func() { close(release) }) }
			scheduler, err := NewScheduler(jobs, SchedulerConfig{QueueCapacity: 1, WorkerLimit: 1}, func(ctx context.Context, job model.Job) error {
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
			job := model.Job{ID: "j_000000000094", BatchID: "b_000000000094", Kind: model.JobScan, RequestJSON: `{}`}
			if _, err := scheduler.Submit(t.Context(), []model.Job{job}); err != nil {
				t.Fatal(err)
			}
			scheduler.Start()
			<-started
			if test.cancelFirst {
				cancelled, err := scheduler.Cancel(t.Context(), job.ID)
				if err != nil || cancelled.State != model.JobCancelled {
					t.Fatalf("cancellation = %#v, %v", cancelled, err)
				}
				if err := <-succeedAttempted; !errors.Is(err, model.ErrJobState) {
					t.Fatalf("runner success after cancellation = %v", err)
				}
			} else {
				if err := <-succeedAttempted; err != nil {
					t.Fatalf("runner success = %v", err)
				}
				if cancelled, err := scheduler.Cancel(t.Context(), job.ID); err != nil || cancelled.State != model.JobSucceeded {
					t.Fatalf("cancellation after success = %#v, %v", cancelled, err)
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
				if stored.State != model.JobCancelled {
					t.Fatalf("stored cancelled job = %#v", stored)
				}
			} else if stored.State != model.JobSucceeded || !stored.ResultJSON.Valid || stored.ResultJSON.String != `{"output":"published"}` {
				t.Fatalf("stored successful job = %#v", stored)
			}
		})
	}
}

func TestSchedulerAdmissionReturnsCommittedJobsAfterContextCancellation(t *testing.T) {
	tests := []struct {
		name   string
		jobs   []model.Job
		submit func(*Scheduler, context.Context, []model.Job) ([]model.Job, error)
	}{
		{
			name: "batch",
			jobs: []model.Job{{ID: "j_000000000091", BatchID: "b_000000000091", Kind: model.JobScan, RequestJSON: `{}`}},
			submit: func(s *Scheduler, ctx context.Context, jobs []model.Job) ([]model.Job, error) {
				return s.Submit(ctx, jobs)
			},
		},
		{
			name: "proposal",
			jobs: []model.Job{{ID: "j_000000000092", BatchID: "b_000000000092", Kind: model.JobExport, ProjectID: "p_project", ProjectItemID: "i_item", ProposalID: "ep_proposal", CredentialID: "c_credential", RequestJSON: `{}`}},
			submit: func(s *Scheduler, ctx context.Context, jobs []model.Job) ([]model.Job, error) {
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
			jobs, err := newTestJobsStore(database)
			if err != nil {
				t.Fatal(err)
			}
			scheduler, err := NewScheduler(jobs, SchedulerConfig{QueueCapacity: 1, WorkerLimit: 1}, func(context.Context, model.Job) error { return nil })
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
				if returned.ID != test.jobs[i].ID || returned.State != model.JobQueued || returned.CreatedAt.IsZero() || returned.UpdatedAt.IsZero() {
					t.Fatalf("returned job %d = %#v", i, returned)
				}
				stored, err := jobs.Get(t.Context(), returned.ID)
				if err != nil {
					t.Fatal(err)
				}
				if stored.State != model.JobQueued || !stored.CreatedAt.Equal(returned.CreatedAt) || !stored.UpdatedAt.Equal(returned.UpdatedAt) {
					t.Fatalf("stored job %d = %#v, returned = %#v", i, stored, returned)
				}
			}
		})
	}
}

func TestSchedulerPersistsTerminalStateAfterSoleConnectionContention(t *testing.T) {
	for _, stage := range []string{"initial_read", "terminal_write", "cancellation"} {
		t.Run(stage, func(t *testing.T) {
			database := openSchedulerTestDatabase(t)
			t.Cleanup(func() {
				if err := database.Close(); err != nil {
					t.Error(err)
				}
			})
			jobs, err := newTestJobsStore(database)
			if err != nil {
				t.Fatal(err)
			}
			runnerReady := make(chan struct{})
			runnerRelease := make(chan struct{})
			transitionReady := make(chan struct{})
			transitionRelease := make(chan struct{})
			finalized := make(chan struct {
				duration time.Duration
				failed   bool
			}, 1)
			scheduler, err := NewScheduler(jobs, SchedulerConfig{
				QueueCapacity: 1,
				WorkerLimit:   1,
				TerminalFinalization: func(duration time.Duration, failed bool) {
					finalized <- struct {
						duration time.Duration
						failed   bool
					}{duration, failed}
				},
			}, func(context.Context, model.Job) error {
				close(runnerReady)
				<-runnerRelease
				return nil
			})
			if err != nil {
				t.Fatal(err)
			}
			if stage == "terminal_write" {
				var first atomic.Bool
				scheduler.terminalTransition = func(ctx context.Context, id string, target model.JobState, result, _ string) (model.Job, error) {
					if first.CompareAndSwap(false, true) {
						close(transitionReady)
						<-transitionRelease
					}
					return jobs.Succeed(ctx, id, result)
				}
			}
			scheduler.Start()
			job := model.Job{ID: "j_000000000201", BatchID: "b_000000000201", Kind: model.JobScan, RequestJSON: `{}`}
			if _, err := scheduler.Submit(t.Context(), []model.Job{job}); err != nil {
				t.Fatal(err)
			}
			<-runnerReady
			if stage == "terminal_write" {
				close(runnerRelease)
				<-transitionReady
			}
			if stage == "cancellation" {
				cancelled, err := scheduler.Cancel(t.Context(), job.ID)
				if err != nil || cancelled.State != model.JobCancelled {
					t.Fatalf("cancelled job = %#v, %v", cancelled, err)
				}
			}
			connection, err := database.Conn(t.Context())
			if err != nil {
				t.Fatal(err)
			}
			if stage == "terminal_write" {
				close(transitionRelease)
			} else {
				close(runnerRelease)
			}
			time.Sleep(350 * time.Millisecond)
			if err := connection.Close(); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(t.Context(), time.Second)
			defer cancel()
			if err := scheduler.Shutdown(ctx); err != nil {
				t.Fatal(err)
			}
			stored, err := jobs.Get(t.Context(), job.ID)
			if err != nil {
				t.Fatal(err)
			}
			want := model.JobSucceeded
			if stage == "cancellation" {
				want = model.JobCancelled
			}
			if stored.State != want {
				t.Fatalf("job state after transient %s contention = %s, want %s", stage, stored.State, want)
			}
			if got := <-finalized; got.failed {
				t.Fatalf("finalization after transient %s contention failed after %s", stage, got.duration)
			}
		})
	}
}

type countingGetJobPersistence struct {
	Persistence
	calls atomic.Int32
}

func (p *countingGetJobPersistence) GetJob(context.Context, string) (model.Job, error) {
	p.calls.Add(1)
	return model.Job{}, errors.New("permanent initial read failure")
}

func TestSchedulerRecordsPermanentInitialReadFailureWithoutRetrying(t *testing.T) {
	database := openSchedulerTestDatabase(t)
	t.Cleanup(func() {
		if err := database.Close(); err != nil {
			t.Error(err)
		}
	})
	baseJobs, err := newTestJobsStore(database)
	if err != nil {
		t.Fatal(err)
	}
	storage := &countingGetJobPersistence{Persistence: baseJobs.storage}
	jobs, err := NewJobsStore(storage)
	if err != nil {
		t.Fatal(err)
	}
	observed := make(chan struct {
		duration time.Duration
		failed   bool
	}, 1)
	var logs bytes.Buffer
	scheduler, err := NewScheduler(jobs, SchedulerConfig{
		QueueCapacity: 1,
		WorkerLimit:   1,
		Logger:        log.New(&logs, "", 0),
		TerminalFinalization: func(duration time.Duration, failed bool) {
			observed <- struct {
				duration time.Duration
				failed   bool
			}{duration, failed}
		},
	}, func(context.Context, model.Job) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	scheduler.finalize(model.Job{ID: "j_missing"}, errors.New("runner failed"), nil)
	got := <-observed
	if !got.failed {
		t.Fatal("permanent initial terminal state read failure was not reported")
	}
	if calls := storage.calls.Load(); calls != 1 {
		t.Fatalf("permanent initial terminal state read calls = %d, want 1", calls)
	}
	if got.duration >= time.Second {
		t.Fatalf("permanent initial read error spent %s retrying", got.duration)
	}
	if count := bytes.Count(logs.Bytes(), []byte(`"event":"job_terminal_failure"`)); count != 1 || !bytes.Contains(logs.Bytes(), []byte(`"error_category":"terminal_state_read"`)) {
		t.Fatalf("permanent initial read failure logs = %q, want one terminal_state_read event", logs.String())
	}
}

func TestSchedulerTerminalFailureLogIsValidJSON(t *testing.T) {
	var logs bytes.Buffer
	scheduler := &Scheduler{logger: log.New(&logs, "", 0)}
	id := "quote\" control\n\x00 Unicode \u2028🙂"
	scheduler.logTerminalFailure(id, model.JobFailed, "terminal_transition")
	var entry struct {
		JobID       string `json:"job_id"`
		TargetState string `json:"target_state"`
		Category    string `json:"error_category"`
	}
	if err := json.Unmarshal(bytes.TrimSpace(logs.Bytes()), &entry); err != nil {
		t.Fatalf("decode log: %v; record=%q", err, logs.String())
	}
	if entry.JobID != id || entry.TargetState != string(model.JobFailed) || entry.Category != "terminal_transition" {
		t.Fatalf("unexpected terminal failure log: %q (%#v)", logs.String(), entry)
	}
}

func TestSchedulerRetriesTransientTerminalTransitionWithoutRerunning(t *testing.T) {
	for _, test := range []struct {
		name       string
		runnerErr  error
		wantState  model.JobState
		wantResult string
	}{
		{
			name:      "success",
			wantState: model.JobSucceeded,
		},
		{
			name:      "failure",
			runnerErr: errors.New("runner failed"),
			wantState: model.JobFailed,
		},
		{
			name:       "published_result",
			runnerErr:  &ResultPersistenceError{Result: `{"output":"published"}`, Err: errors.New("result write failed")},
			wantState:  model.JobSucceeded,
			wantResult: `{"output":"published"}`,
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			database := openSchedulerTestDatabase(t)
			t.Cleanup(func() {
				if err := database.Close(); err != nil {
					t.Error(err)
				}
			})
			jobs, err := newTestJobsStore(database)
			if err != nil {
				t.Fatal(err)
			}
			var executions atomic.Int32
			var attempts atomic.Int32
			var logs synchronizedBuffer
			scheduler, err := NewScheduler(jobs, SchedulerConfig{
				QueueCapacity: 1,
				WorkerLimit:   1,
				Logger:        log.New(&logs, "", 0),
			}, func(context.Context, model.Job) error {
				executions.Add(1)
				return test.runnerErr
			})
			if err != nil {
				t.Fatal(err)
			}
			var expectedResult string
			scheduler.terminalTransition = func(ctx context.Context, id string, target model.JobState, result, code string) (model.Job, error) {
				if target != test.wantState {
					t.Fatalf("terminal target = %s, want %s", target, test.wantState)
				}
				if target == model.JobSucceeded {
					expectedResult = result
				}
				if got := attempts.Add(1); got <= 2 {
					return model.Job{}, context.DeadlineExceeded
				}
				if target == model.JobSucceeded {
					return jobs.Succeed(ctx, id, result)
				}
				return jobs.Fail(ctx, id, code)
			}
			scheduler.Start()
			job := model.Job{ID: "j_000000000101", BatchID: "b_000000000101", Kind: model.JobScan, RequestJSON: `{}`}
			if _, err := scheduler.Submit(t.Context(), []model.Job{job}); err != nil {
				t.Fatal(err)
			}
			waitForJobState(t, jobs, job.ID, test.wantState)
			if err := scheduler.Shutdown(context.Background()); err != nil {
				t.Fatal(err)
			}
			stored, err := jobs.Get(t.Context(), job.ID)
			if err != nil {
				t.Fatal(err)
			}
			if executions.Load() != 1 {
				t.Fatalf("runner executions = %d, want 1", executions.Load())
			}
			if attempts.Load() != 3 {
				t.Fatalf("terminal attempts = %d, want 3", attempts.Load())
			}
			if test.wantResult != "" {
				if !stored.ResultJSON.Valid || stored.ResultJSON.String != test.wantResult {
					t.Fatalf("stored published result = %#v, want %q", stored.ResultJSON, test.wantResult)
				}
			} else if test.wantState == model.JobSucceeded && stored.ResultJSON.String != expectedResult {
				t.Fatalf("stored success result = %q, want %q", stored.ResultJSON.String, expectedResult)
			}
			if logs.Len() != 0 {
				t.Fatalf("unexpected terminal failure log = %q", logs.String())
			}
		})
	}
}

func TestSchedulerClassifiesTerminalContentionErrors(t *testing.T) {
	database := openSchedulerTestDatabase(t)
	database.SetMaxOpenConns(2)
	first, err := database.Conn(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := first.Close(); err != nil {
			t.Error(err)
		}
	}()
	second, err := database.Conn(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := second.Close(); err != nil {
			t.Error(err)
		}
	}()
	if _, err := second.ExecContext(t.Context(), `PRAGMA busy_timeout = 1`); err != nil {
		t.Fatal(err)
	}
	if _, err := first.ExecContext(t.Context(), `BEGIN EXCLUSIVE`); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if _, err := first.ExecContext(context.Background(), `ROLLBACK`); err != nil {
			t.Error(err)
		}
	}()
	if _, err := second.ExecContext(t.Context(), `UPDATE jobs SET state='running'`); err == nil {
		t.Fatal("locked SQLite update unexpectedly succeeded")
	} else if !isTransientTerminalError(err) {
		t.Fatalf("SQLite lock error %T (%v) was not classified as transient contention", err, err)
	}
	for _, err := range []error{context.DeadlineExceeded, errors.New("disk I/O failure"), context.Canceled} {
		if isTransientTerminalError(err) != errors.Is(err, context.DeadlineExceeded) {
			t.Errorf("isTransientTerminalError(%v) = %t", err, isTransientTerminalError(err))
		}
	}
}

func TestSchedulerFinalVerificationPreservesConcurrentCancellation(t *testing.T) {
	database := openSchedulerTestDatabase(t)
	t.Cleanup(func() {
		if err := database.Close(); err != nil {
			t.Error(err)
		}
	})
	jobs, err := newTestJobsStore(database)
	if err != nil {
		t.Fatal(err)
	}
	job := model.Job{ID: "j_000000000202", BatchID: "b_000000000202", Kind: model.JobScan, RequestJSON: `{}`}
	if _, err := jobs.Create(t.Context(), job); err != nil {
		t.Fatal(err)
	}
	job, err = jobs.Start(t.Context(), job.ID)
	if err != nil {
		t.Fatal(err)
	}
	var logs synchronizedBuffer
	finalized := make(chan bool, 1)
	scheduler, err := NewScheduler(jobs, SchedulerConfig{
		QueueCapacity: 1,
		WorkerLimit:   1,
		Logger:        log.New(&logs, "", 0),
		TerminalFinalization: func(_ time.Duration, failed bool) {
			finalized <- failed
		},
	}, func(context.Context, model.Job) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	scheduler.terminalTransition = func(ctx context.Context, id string, target model.JobState, _, _ string) (model.Job, error) {
		if target != model.JobSucceeded {
			return model.Job{}, errors.New("unexpected terminal target")
		}
		if _, err := jobs.Cancel(ctx, id); err != nil {
			return model.Job{}, err
		}
		return model.Job{}, model.ErrJobState
	}
	scheduler.finalize(job, nil, nil)
	stored, err := jobs.Get(t.Context(), job.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.State != model.JobCancelled {
		t.Fatalf("concurrent cancellation was overwritten: stored state = %s", stored.State)
	}
	if failed := <-finalized; failed {
		t.Fatal("terminal CAS lost to cancellation was reported as a finalization failure")
	}
	if logs.Len() != 0 {
		t.Fatalf("unexpected terminal failure log after cancellation won: %q", logs.String())
	}
}

func TestSchedulerFinalizationDeadlineBoundsWorkerShutdown(t *testing.T) {
	database := openSchedulerTestDatabase(t)
	t.Cleanup(func() {
		if err := database.Close(); err != nil {
			t.Error(err)
		}
	})
	jobs, err := newTestJobsStore(database)
	if err != nil {
		t.Fatal(err)
	}
	runnerStarted := make(chan struct{})
	runnerRelease := make(chan struct{})
	transitionStarted := make(chan struct{})
	transitionRelease := make(chan struct{})
	var releaseRunnerOnce, releaseTransitionOnce sync.Once
	releaseRunner := func() { releaseRunnerOnce.Do(func() { close(runnerRelease) }) }
	releaseTransition := func() { releaseTransitionOnce.Do(func() { close(transitionRelease) }) }
	finalized := make(chan struct {
		duration time.Duration
		failed   bool
	}, 1)
	var attempts atomic.Int32
	var logs synchronizedBuffer
	scheduler, err := NewScheduler(jobs, SchedulerConfig{
		QueueCapacity: 1,
		WorkerLimit:   1,
		Logger:        log.New(&logs, "", 0),
		TerminalFinalization: func(duration time.Duration, failed bool) {
			finalized <- struct {
				duration time.Duration
				failed   bool
			}{duration, failed}
		},
	}, func(context.Context, model.Job) error {
		close(runnerStarted)
		<-runnerRelease
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	var initialConnection, connection *sql.Conn
	t.Cleanup(func() {
		releaseRunner()
		releaseTransition()
		if initialConnection != nil {
			_ = initialConnection.Close()
		}
		if connection != nil {
			_ = connection.Close()
		}
		ctx, cancel := context.WithTimeout(context.Background(), terminalFinalizationTimeout+time.Second)
		defer cancel()
		if err := scheduler.Shutdown(ctx); err != nil {
			t.Errorf("cleanup scheduler shutdown: %v", err)
		}
	})
	scheduler.terminalTransition = func(ctx context.Context, id string, target model.JobState, result, _ string) (model.Job, error) {
		if attempts.Add(1) == 1 {
			close(transitionStarted)
			<-transitionRelease
		}
		return jobs.Succeed(ctx, id, result)
	}
	scheduler.Start()
	job := model.Job{ID: "j_000000000203", BatchID: "b_000000000203", Kind: model.JobScan, RequestJSON: `{}`}
	if _, err := scheduler.Submit(t.Context(), []model.Job{job}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-runnerStarted:
	case <-time.After(time.Second):
		t.Fatal("runner did not start")
	}
	initialConnection, err = database.Conn(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	waitForDatabaseWait := func(previous int64) bool {
		deadline := time.NewTimer(time.Second)
		defer deadline.Stop()
		poll := time.NewTicker(time.Millisecond)
		defer poll.Stop()
		for database.Stats().WaitCount == previous {
			select {
			case <-poll.C:
			case <-deadline.C:
				return false
			}
		}
		return true
	}
	initialWaits := database.Stats().WaitCount
	finalizationStarted := time.Now()
	releaseRunner()
	if !waitForDatabaseWait(initialWaits) {
		t.Fatal("initial terminal read did not contend for the sole database connection")
	}
	// Keep the read contended for most of the total budget, leaving time to enter the write phase.
	hold := time.NewTimer(3 * time.Second)
	select {
	case <-hold.C:
	case <-t.Context().Done():
		hold.Stop()
		t.Fatal("test context ended while holding the database connection")
	}
	if err := initialConnection.Close(); err != nil {
		t.Fatal(err)
	}
	initialConnection = nil
	select {
	case <-transitionStarted:
	case <-time.After(time.Second):
		t.Fatal("terminal transition did not follow the contended initial read")
	}
	connection, err = database.Conn(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	waits := database.Stats().WaitCount
	releaseTransition()
	if !waitForDatabaseWait(waits) {
		t.Fatal("terminal write did not contend for the sole database connection")
	}
	shutdownStarted := time.Now()
	ctx, cancel := context.WithTimeout(t.Context(), terminalFinalizationTimeout+time.Second)
	defer cancel()
	if err := scheduler.Shutdown(ctx); err != nil {
		t.Fatalf("shutdown while terminal persistence contended: %v", err)
	}
	shutdownDuration := time.Since(shutdownStarted)
	if shutdownDuration > terminalFinalizationTimeout+time.Second {
		t.Fatalf("shutdown took %s, exceeded shared finalization budget", shutdownDuration)
	}
	fullShutdownDuration := time.Since(finalizationStarted)
	if fullShutdownDuration > terminalFinalizationTimeout+500*time.Millisecond {
		t.Fatalf("worker finalization and shutdown took %s, exceeded shared finalization budget", fullShutdownDuration)
	}
	if err := connection.Close(); err != nil {
		t.Fatal(err)
	}
	connection = nil
	got := <-finalized
	if !got.failed {
		t.Fatal("exhausted terminal write was not reported as a failure")
	}
	if got.duration < terminalFinalizationTimeout-time.Second || got.duration > terminalFinalizationTimeout+time.Second {
		t.Fatalf("finalization duration = %s, want approximately the shared %s budget", got.duration, terminalFinalizationTimeout)
	}
	t.Logf("contended finalization = %s; shutdown wait after write contention = %s; total from runner release = %s", got.duration, shutdownDuration, fullShutdownDuration)
	if attempts.Load() < 10 {
		t.Fatalf("transient terminal attempts = %d, want repeated retries", attempts.Load())
	}
	var event struct {
		JobID         string `json:"job_id"`
		TargetState   string `json:"target_state"`
		ErrorCategory string `json:"error_category"`
	}
	if err := json.Unmarshal(bytes.TrimSpace(logs.Bytes()), &event); err != nil {
		t.Fatalf("terminal failure log is not structured JSON: %v", err)
	}
	if event.JobID != job.ID || event.ErrorCategory != "terminal_transition" {
		t.Fatalf("unexpected exhausted terminal failure log: %#v", event)
	}
	stored, err := jobs.Get(t.Context(), job.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.State != model.JobRunning {
		t.Fatalf("stored state after bounded terminal exhaustion = %s, want running", stored.State)
	}
}

func TestSchedulerStopsRetryingPermanentTerminalTransitionErrors(t *testing.T) {
	database := openSchedulerTestDatabase(t)
	t.Cleanup(func() {
		if err := database.Close(); err != nil {
			t.Error(err)
		}
	})
	jobs, err := newTestJobsStore(database)
	if err != nil {
		t.Fatal(err)
	}
	var attempts atomic.Int32
	var logs synchronizedBuffer
	scheduler, err := NewScheduler(jobs, SchedulerConfig{
		QueueCapacity: 1,
		WorkerLimit:   1,
		Logger:        log.New(&logs, "", 0),
	}, func(context.Context, model.Job) error {
		return &ResultPersistenceError{
			Result: `{"output":"published"}`,
			Err:    errors.New("permanent terminal write"),
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	scheduler.terminalTransition = func(context.Context, string, model.JobState, string, string) (model.Job, error) {
		attempts.Add(1)
		return model.Job{}, errors.New("permanent terminal write")
	}
	scheduler.Start()
	job := model.Job{ID: "j_000000000102", BatchID: "b_000000000102", Kind: model.JobScan, RequestJSON: `{}`}
	if _, err := scheduler.Submit(t.Context(), []model.Job{job}); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(time.Second)
	for attempts.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if attempts.Load() != 1 {
		t.Fatalf("permanent terminal attempts = %d, want 1", attempts.Load())
	}
	stored, err := jobs.Get(t.Context(), job.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.State != model.JobRunning {
		t.Fatalf("stored state = %s, want running after exhausted write", stored.State)
	}
	if stored.ResultJSON.Valid {
		t.Fatalf("stored result unexpectedly set = %#v", stored.ResultJSON)
	}
	ctx, cancel := context.WithTimeout(t.Context(), time.Second)
	defer cancel()
	if err := scheduler.Shutdown(ctx); err != nil {
		t.Fatalf("shutdown after exhausted write = %v", err)
	}
	var event struct {
		JobID         string         `json:"job_id"`
		TargetState   model.JobState `json:"target_state"`
		ErrorCategory string         `json:"error_category"`
	}
	if err := json.Unmarshal(logs.Bytes(), &event); err != nil {
		t.Fatalf("terminal failure log is not structured JSON: %v", err)
	}
	if event.JobID != job.ID || event.TargetState != model.JobSucceeded || event.ErrorCategory != "terminal_transition" {
		t.Fatalf("unexpected terminal failure event: %#v", event)
	}
	if logged := logs.String(); bytes.Contains([]byte(logged), []byte("permanent terminal write")) || bytes.Contains([]byte(logged), []byte(`{"output":"published"}`)) {
		t.Fatalf("log leaked transition details = %q", logged)
	}
}
