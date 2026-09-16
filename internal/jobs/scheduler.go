package jobs

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"sync"
	"time"
)

var (
	ErrQueueFull        = errors.New("job queue capacity exceeded")
	ErrSchedulerStopped = errors.New("job scheduler stopped")
	ErrSourceChanged    = errors.New("source_changed")
)

// MaxWorkerLimit is a resource-safety ceiling, not recommended concurrency.
const MaxWorkerLimit = 64

// SchedulerConfig keeps durable backlog admission independent of active workers.
type SchedulerConfig struct {
	QueueCapacity int
	WorkerLimit   int
}

func (c SchedulerConfig) validate() error {
	if c.QueueCapacity < 1 || c.WorkerLimit < 1 || c.WorkerLimit > MaxWorkerLimit {
		return fmt.Errorf("queue capacity must be positive and worker limit must be 1..%d", MaxWorkerLimit)
	}
	return nil
}

// JobRunner executes one claimed job. It must not expose filesystem paths in
// returned errors because those are persisted as job failure codes only.
type JobRunner func(context.Context, Job) error

// Scheduler claims durable jobs and bounds concurrent executions.
type Scheduler struct {
	jobs   *JobsStore
	runner JobRunner
	config SchedulerConfig
	ctx    context.Context
	cancel context.CancelFunc

	mu      sync.Mutex
	running map[string]runningJob
	started bool
	workers int

	// afterClaim is a test seam for the claimed-but-not-registered handoff.
	afterClaim func()
	// afterCommit is a test seam for cancellation after durable admission.
	afterCommit func()
	// afterDeregister is a test seam for cancellation after runner completion.
	afterDeregister func()
	stopped         bool
	wake            chan struct{}
	stop            chan struct{}
	done            sync.WaitGroup
}

func NewScheduler(jobs *JobsStore, config SchedulerConfig, runner JobRunner) (*Scheduler, error) {
	if jobs == nil || runner == nil {
		return nil, errors.New("job store and runner are required")
	}
	if err := config.validate(); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	return &Scheduler{jobs: jobs, runner: runner, config: config, ctx: ctx, cancel: cancel, running: make(map[string]runningJob), wake: make(chan struct{}, 1), stop: make(chan struct{})}, nil
}

// Submit atomically admits a whole batch or creates none of its child jobs.
func (s *Scheduler) Submit(ctx context.Context, jobs []Job) (out []Job, err error) {
	ctx, cancel := s.requestContext(ctx)
	defer cancel()
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.stopped {
		return nil, ErrSchedulerStopped
	}
	if len(jobs) == 0 {
		return nil, errors.New("batch must contain a job")
	}
	if len(jobs) > s.config.QueueCapacity {
		return nil, ErrQueueFull
	}
	tx, err := s.jobs.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() {
		if rollbackErr := tx.Rollback(); rollbackErr != nil && !errors.Is(rollbackErr, sql.ErrTxDone) {
			err = errors.Join(err, fmt.Errorf("rollback job admission: %w", rollbackErr))
		}
	}()
	var queued int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM jobs WHERE state IN ('queued','running')`).Scan(&queued); err != nil {
		return nil, err
	}
	if queued+len(jobs) > s.config.QueueCapacity {
		return nil, ErrQueueFull
	}
	now := time.Now().UTC()
	stamp := now.Format(time.RFC3339Nano)
	out = make([]Job, len(jobs))
	for i, job := range jobs {
		if err := validateNewJob(job); err != nil {
			return nil, err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO jobs (id,batch_id,kind,project_id,project_item_id,proposal_id,credential_id,state,request_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`, job.ID, job.BatchID, job.Kind, nullString(job.ProjectID), nullString(job.ProjectItemID), nullString(job.ProposalID), nullString(job.CredentialID), JobQueued, job.RequestJSON, stamp, stamp); err != nil {
			return nil, fmt.Errorf("create job: %w", err)
		}
		out[i] = queuedJob(job, now)
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	if s.afterCommit != nil {
		s.afterCommit()
	}
	s.signal()
	return out, nil
}

// SubmitProposal atomically returns the jobs already bound to a proposal or
// admits its exact export batch. This is the proposal idempotency boundary.
func (s *Scheduler) SubmitProposal(ctx context.Context, proposalID, credentialID string, jobs []Job) ([]Job, error) {
	ctx, cancel := s.requestContext(ctx)
	defer cancel()
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.stopped {
		return nil, ErrSchedulerStopped
	}
	if proposalID == "" || credentialID == "" || len(jobs) == 0 {
		return nil, errors.New("proposal export jobs are required")
	}
	tx, err := s.jobs.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	var existing int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM jobs WHERE proposal_id = ?`, proposalID).Scan(&existing); err != nil {
		return nil, err
	}
	if existing > 0 {
		if err := tx.Rollback(); err != nil {
			return nil, err
		}
		return s.jobs.ListByProposal(ctx, proposalID)
	}
	var queued int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM jobs WHERE state IN ('queued','running')`).Scan(&queued); err != nil {
		return nil, err
	}
	if queued+len(jobs) > s.config.QueueCapacity {
		return nil, ErrQueueFull
	}
	now := time.Now().UTC()
	stamp := now.Format(time.RFC3339Nano)
	out := make([]Job, len(jobs))
	for i, job := range jobs {
		if err := validateNewJob(job); err != nil || job.Kind != JobExport || job.ProposalID != proposalID || job.CredentialID != credentialID {
			return nil, errors.New("invalid proposal export job")
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO jobs (id,batch_id,kind,project_id,project_item_id,proposal_id,credential_id,state,request_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`, job.ID, job.BatchID, job.Kind, job.ProjectID, job.ProjectItemID, proposalID, credentialID, JobQueued, job.RequestJSON, stamp, stamp); err != nil {
			return nil, fmt.Errorf("create proposal job: %w", err)
		}
		out[i] = queuedJob(job, now)
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	if s.afterCommit != nil {
		s.afterCommit()
	}
	s.signal()
	return out, nil
}

func queuedJob(job Job, now time.Time) Job {
	job.State = JobQueued
	job.ResultJSON = sql.NullString{}
	job.ErrorCode = sql.NullString{}
	job.CreatedAt = now
	job.UpdatedAt = now
	return job
}

func validateNewJob(job Job) error {
	if !jobIDPattern.MatchString(job.ID) || !batchIDPattern.MatchString(job.BatchID) || job.RequestJSON == "" || !validJobKind(job.Kind) {
		return errors.New("valid job ID, batch ID, kind, and request are required")
	}
	if job.Kind != JobScan && (job.ProjectID == "" || job.ProjectItemID == "") {
		return errors.New("project job requires project and item")
	}
	if job.Kind == JobScan && (job.ProjectID != "" || job.ProjectItemID != "") {
		return errors.New("library scan cannot reference a project item")
	}
	return nil
}

// Start begins bounded workers. Queued jobs are intentionally left queued on shutdown.
func (s *Scheduler) Start() {
	s.mu.Lock()
	if s.started || s.stopped {
		s.mu.Unlock()
		return
	}
	s.started = true
	s.startWorkers()
	s.mu.Unlock()
	s.signal()
}

// SetLimits changes admission and execution capacity without cancelling active
// jobs or discarding queued work. Excess workers retire after their current job.
func (s *Scheduler) SetLimits(config SchedulerConfig) error {
	if err := config.validate(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.stopped {
		return ErrSchedulerStopped
	}
	s.config = config
	if s.started {
		s.startWorkers()
	}
	return nil
}

// startWorkers requires mu; Shutdown excludes all future WaitGroup additions.
func (s *Scheduler) startWorkers() {
	for s.workers < s.config.WorkerLimit {
		s.workers++
		s.done.Go(s.worker)
	}
}

func (s *Scheduler) Shutdown(ctx context.Context) error {
	// Unblock database work holding mu before waiting to stop registration.
	s.cancel()
	s.mu.Lock()
	if !s.stopped {
		s.stopped = true
		close(s.stop)
		for _, running := range s.running {
			running.cancel()
		}
	}
	s.mu.Unlock()
	finished := make(chan struct{})
	go func() { s.done.Wait(); close(finished) }()
	select {
	case <-finished:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (s *Scheduler) CancelBatch(ctx context.Context, batchID string) (err error) {
	rows, err := s.jobs.db.QueryContext(ctx, `SELECT id FROM jobs WHERE batch_id=? AND state IN ('queued','running')`, batchID)
	if err != nil {
		return err
	}
	rowsClosed := false
	closeRows := func() error {
		if rowsClosed {
			return nil
		}
		rowsClosed = true
		return rows.Close()
	}
	defer func() {
		if closeErr := closeRows(); closeErr != nil {
			err = errors.Join(err, fmt.Errorf("close scheduler batch rows: %w", closeErr))
		}
	}()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if closeErr := closeRows(); closeErr != nil {
		return fmt.Errorf("close scheduler batch rows: %w", closeErr)
	}
	for _, id := range ids {
		if _, err := s.Cancel(ctx, id); err != nil && !errors.Is(err, ErrJobState) {
			return err
		}
	}
	return nil
}

// Get returns the durable record while keeping MCP job control on the scheduler.
func (s *Scheduler) Get(ctx context.Context, id string) (Job, error) {
	return s.jobs.Get(ctx, id)
}

func (s *Scheduler) Cancel(ctx context.Context, id string) (Job, error) {
	ctx, cancel := s.requestContext(ctx)
	defer cancel()
	s.mu.Lock()
	defer s.mu.Unlock()
	// The durable CAS arbitrates cancellation against a runner's terminal
	// transition. Keep the running entry until the runner exits so cleanup and
	// worker capacity still reflect the live process.
	job, err := s.jobs.Cancel(ctx, id)
	if err != nil {
		return Job{}, err
	}
	if running, ok := s.running[id]; ok {
		running.cancel()
	}
	return job, nil
}

// requestContext keeps admission/cancellation database work bounded by both
// its caller and scheduler shutdown, including while it holds the lifecycle lock.
func (s *Scheduler) requestContext(ctx context.Context) (context.Context, context.CancelFunc) {
	ctx, cancel := context.WithCancel(ctx)
	stop := context.AfterFunc(s.ctx, cancel)
	return ctx, func() { stop(); cancel() }
}

func (s *Scheduler) worker() {
	for {
		s.mu.Lock()
		if s.stopped || s.workers > s.config.WorkerLimit {
			s.workers--
			s.mu.Unlock()
			return
		}
		job, err := s.claim(s.ctx)
		s.mu.Unlock()
		if errors.Is(err, sql.ErrNoRows) {
			select {
			case <-s.wake:
			case <-time.After(100 * time.Millisecond):
			case <-s.stop:
				return
			}
			continue
		}
		if err != nil {
			select {
			case <-time.After(100 * time.Millisecond):
			case <-s.stop:
				return
			}
			continue
		}
		if s.afterClaim != nil {
			s.afterClaim()
		}
		ctx, cancel := context.WithCancel(context.Background())
		s.mu.Lock()
		if s.stopped {
			cancel()
		}
		s.running[job.ID] = runningJob{cancel: cancel}
		s.mu.Unlock()
		current, getErr := s.jobs.Get(context.Background(), job.ID)
		if ctx.Err() != nil || getErr != nil || current.State != JobRunning {
			err = context.Canceled
		} else {
			err = s.runner(ctx, job)
		}
		s.mu.Lock()
		cancelled := ctx.Err() != nil
		delete(s.running, job.ID)
		s.mu.Unlock()
		if s.afterDeregister != nil {
			s.afterDeregister()
		}
		cancel()
		if err == nil {
			// Runners that produce durable results transition the job themselves.
			// Do not overwrite those results with the scheduler's empty default.
			current, getErr := s.jobs.Get(context.Background(), job.ID)
			if getErr == nil && current.State == JobRunning {
				_, _ = s.jobs.Succeed(context.Background(), job.ID, `{}`)
			}
		} else if cancelled {
			_, _ = s.jobs.Cancel(context.Background(), job.ID)
		} else {
			code := "job_failed"
			if errors.Is(err, ErrSourceChanged) {
				code = "source_changed"
			}
			_, _ = s.jobs.Fail(context.Background(), job.ID, code)
		}
	}
}

type runningJob struct {
	cancel context.CancelFunc
}

func (s *Scheduler) claim(ctx context.Context) (job Job, err error) {
	tx, err := s.jobs.db.BeginTx(ctx, nil)
	if err != nil {
		return Job{}, err
	}
	defer func() {
		if rollbackErr := tx.Rollback(); rollbackErr != nil && !errors.Is(rollbackErr, sql.ErrTxDone) {
			err = errors.Join(err, fmt.Errorf("rollback job claim: %w", rollbackErr))
		}
	}()
	var id string
	if err := tx.QueryRowContext(ctx, `SELECT id FROM jobs WHERE state=? ORDER BY created_at,id LIMIT 1`, JobQueued).Scan(&id); err != nil {
		return Job{}, err
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	r, err := tx.ExecContext(ctx, `UPDATE jobs SET state=?,updated_at=? WHERE id=? AND state=?`, JobRunning, now, id, JobQueued)
	if err != nil {
		return Job{}, err
	}
	n, err := r.RowsAffected()
	if err != nil || n != 1 {
		return Job{}, sql.ErrNoRows
	}
	row := tx.QueryRowContext(ctx, `SELECT id,batch_id,kind,COALESCE(project_id,''),COALESCE(project_item_id,''),COALESCE(proposal_id,''),COALESCE(credential_id,''),state,request_json,result_json,error_code,created_at,updated_at FROM jobs WHERE id=?`, id)
	job, err = scanUnifiedJob(row)
	if err != nil {
		return Job{}, err
	}
	if err := tx.Commit(); err != nil {
		return Job{}, err
	}
	return job, nil
}

func (s *Scheduler) signal() {
	select {
	case s.wake <- struct{}{}:
	default:
	}
}
