package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"sync"
	"time"
)

var ErrQueueFull = errors.New("job queue capacity exceeded")

// SchedulerConfig keeps durable backlog admission independent of active workers.
type SchedulerConfig struct {
	QueueCapacity int
	WorkerLimit   int
}

func (c SchedulerConfig) validate() error {
	if c.QueueCapacity < 1 || c.WorkerLimit < 1 {
		return errors.New("queue capacity and worker limit must be positive")
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

	mu      sync.Mutex
	running map[string]runningJob
	started bool

	// beforeStart is a test seam for the claim-to-invocation boundary.
	beforeStart func()
	stopped     bool
	wake        chan struct{}
	stop        chan struct{}
	done        sync.WaitGroup
}

func NewScheduler(jobs *JobsStore, config SchedulerConfig, runner JobRunner) (*Scheduler, error) {
	if jobs == nil || runner == nil {
		return nil, errors.New("job store and runner are required")
	}
	if err := config.validate(); err != nil {
		return nil, err
	}
	return &Scheduler{jobs: jobs, runner: runner, config: config, running: make(map[string]runningJob), wake: make(chan struct{}, 1), stop: make(chan struct{})}, nil
}

// Submit atomically admits a whole batch or creates none of its child jobs.
func (s *Scheduler) Submit(ctx context.Context, jobs []Job) ([]Job, error) {
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
	defer tx.Rollback()
	var queued int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM jobs WHERE state IN ('queued','running')`).Scan(&queued); err != nil {
		return nil, err
	}
	if queued+len(jobs) > s.config.QueueCapacity {
		return nil, ErrQueueFull
	}
	for _, job := range jobs {
		if err := validateNewJob(job); err != nil {
			return nil, err
		}
		now := time.Now().UTC().Format(time.RFC3339Nano)
		if _, err := tx.ExecContext(ctx, `INSERT INTO jobs (id,batch_id,kind,project_id,project_item_id,state,request_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`, job.ID, job.BatchID, job.Kind, nullString(job.ProjectID), nullString(job.ProjectItemID), JobQueued, job.RequestJSON, now, now); err != nil {
			return nil, fmt.Errorf("create job: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	out := make([]Job, len(jobs))
	for i := range jobs {
		out[i], err = s.jobs.Get(ctx, jobs[i].ID)
		if err != nil {
			return nil, err
		}
	}
	s.signal()
	return out, nil
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
	s.done.Add(s.config.WorkerLimit)
	for range s.config.WorkerLimit {
		go s.worker()
	}
	s.mu.Unlock()
	s.signal()
}

func (s *Scheduler) Shutdown(ctx context.Context) error {
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

func (s *Scheduler) Cancel(ctx context.Context, id string) (Job, error) {
	// Serializing the state transition with runner registration ensures a claimed
	// job receives cancellation before the runner may begin.
	s.mu.Lock()
	defer s.mu.Unlock()
	job, err := s.jobs.Cancel(ctx, id)
	if err != nil {
		return Job{}, err
	}
	if running, ok := s.running[id]; ok {
		running.cancel()
	}
	return job, nil
}

func (s *Scheduler) worker() {
	defer s.done.Done()
	for {
		select {
		case <-s.stop:
			return
		default:
		}
		job, err := s.claim(context.Background())
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
		ctx, cancel := context.WithCancel(context.Background())
		s.mu.Lock()
		s.running[job.ID] = runningJob{cancel: cancel}
		s.mu.Unlock()
		if s.beforeStart != nil {
			s.beforeStart()
		}
		s.mu.Lock()
		current, stateErr := s.jobs.Get(context.Background(), job.ID)
		if stateErr != nil || current.State != JobRunning || s.stopped || ctx.Err() != nil {
			cancel()
			s.mu.Unlock()
			err = context.Canceled
		} else {
			// Once started is set, cancellation may stop the context but cannot
			// claim that it prevented this runner invocation.
			running := s.running[job.ID]
			running.started = true
			s.running[job.ID] = running
			s.mu.Unlock()
			err = s.runner(ctx, job)
		}
		cancel()
		s.mu.Lock()
		delete(s.running, job.ID)
		s.mu.Unlock()
		if err == nil {
			_, _ = s.jobs.Succeed(context.Background(), job.ID, `{}`)
		} else if ctx.Err() != nil {
			_, _ = s.jobs.Cancel(context.Background(), job.ID)
		} else {
			_, _ = s.jobs.Fail(context.Background(), job.ID, "job_failed")
		}
	}
}

type runningJob struct {
	cancel  context.CancelFunc
	started bool
}

func (s *Scheduler) claim(ctx context.Context) (Job, error) {
	tx, err := s.jobs.db.BeginTx(ctx, nil)
	if err != nil {
		return Job{}, err
	}
	defer tx.Rollback()
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
	row := tx.QueryRowContext(ctx, `SELECT id,batch_id,kind,COALESCE(project_id,''),COALESCE(project_item_id,''),state,request_json,result_json,error_code,created_at,updated_at FROM jobs WHERE id=?`, id)
	job, err := scanUnifiedJob(row)
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
