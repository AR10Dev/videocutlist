package jobs

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"sync"
	"time"

	"videocutlist/internal/jobs/model"
	settingsmodel "videocutlist/internal/settings/model"
)

var (
	ErrSchedulerStopped = errors.New("job scheduler stopped")
	ErrSourceChanged    = errors.New("source_changed")
)

const (
	terminalTransitionAttempts = 3
	terminalTransitionTimeout  = 100 * time.Millisecond
	terminalTransitionBackoff  = 10 * time.Millisecond
)

// ResultPersistenceError reports that a runner produced a durable result but
// could not persist it. The scheduler retries the terminal write without
// rerunning the runner.
type ResultPersistenceError struct {
	Result string
	Err    error
}

func (e *ResultPersistenceError) Error() string {
	return "job terminal result persistence failed"
}

func (e *ResultPersistenceError) Unwrap() error {
	return e.Err
}

// SchedulerConfig keeps durable backlog admission independent of active workers.
type SchedulerConfig struct {
	QueueCapacity        int
	WorkerLimit          int
	Logger               *log.Logger
	TerminalFinalization func(time.Duration, bool)
}

func (c SchedulerConfig) validate() error {
	if c.QueueCapacity < 1 || c.WorkerLimit < 1 || c.WorkerLimit > settingsmodel.MaxExportWorkers {
		return fmt.Errorf("queue capacity must be positive and worker limit must be 1..%d", settingsmodel.MaxExportWorkers)
	}
	return nil
}

// JobRunner executes one claimed job. It must not expose filesystem paths in
// returned errors because those are persisted as job failure codes only.
// Runners that own a durable result should return ResultPersistenceError when
// its terminal write fails so the scheduler can retry without rerunning work.
type JobRunner func(context.Context, model.Job) error

// Scheduler claims durable jobs and bounds concurrent executions.
type Scheduler struct {
	jobs   *JobsStore
	runner JobRunner
	config SchedulerConfig
	logger *log.Logger
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
	// terminalTransition wraps one durable terminal write for fault injection.
	terminalTransition func(context.Context, string, model.JobState, string, string) (model.Job, error)
	stopped            bool
	wake               chan struct{}
	stop               chan struct{}
	done               sync.WaitGroup
}

func NewScheduler(jobs *JobsStore, config SchedulerConfig, runner JobRunner) (*Scheduler, error) {
	if jobs == nil || runner == nil {
		return nil, errors.New("job store and runner are required")
	}
	if err := config.validate(); err != nil {
		return nil, err
	}
	logger := config.Logger
	if logger == nil {
		logger = log.Default()
	}
	ctx, cancel := context.WithCancel(context.Background())
	return &Scheduler{jobs: jobs, runner: runner, config: config, logger: logger, ctx: ctx, cancel: cancel, running: make(map[string]runningJob), wake: make(chan struct{}, 1), stop: make(chan struct{})}, nil
}

// Submit atomically admits a whole batch or creates none of its child jobs.
func (s *Scheduler) Submit(ctx context.Context, jobs []model.Job) ([]model.Job, error) {
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
		return nil, model.ErrQueueFull
	}
	created, err := s.jobs.storage.AdmitBatch(ctx, jobs, s.config.QueueCapacity)
	if err != nil {
		return nil, err
	}
	if s.afterCommit != nil {
		s.afterCommit()
	}
	s.signal()
	return created, nil
}

// SubmitProposal atomically returns the jobs already bound to a proposal or
// admits its exact export batch. This is the proposal idempotency boundary.
func (s *Scheduler) SubmitProposal(ctx context.Context, proposalID, credentialID string, jobs []model.Job) ([]model.Job, error) {
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
	created, replayed, err := s.jobs.storage.AdmitProposal(ctx, proposalID, credentialID, jobs, s.config.QueueCapacity)
	if err != nil {
		return nil, err
	}
	if !replayed {
		if s.afterCommit != nil {
			s.afterCommit()
		}
		s.signal()
	}
	return created, nil
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
			running.cancel(ErrSchedulerStopped)
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

func (s *Scheduler) CancelBatch(ctx context.Context, batchID string) error {
	ids, err := s.jobs.storage.ActiveBatchMembers(ctx, batchID)
	if err != nil {
		return err
	}
	if len(ids) == 0 {
		_, _, err := s.jobs.Batch(ctx, batchID)
		return err
	}
	for _, id := range ids {
		if _, err := s.Cancel(ctx, id); err != nil && !errors.Is(err, model.ErrJobState) {
			return err
		}
	}
	return nil
}

// Get returns the durable record while keeping MCP job control on the scheduler.
func (s *Scheduler) Get(ctx context.Context, id string) (model.Job, error) {
	return s.jobs.Get(ctx, id)
}

func (s *Scheduler) Cancel(ctx context.Context, id string) (model.Job, error) {
	ctx, cancel := s.requestContext(ctx)
	defer cancel()
	s.mu.Lock()
	defer s.mu.Unlock()
	// The durable CAS arbitrates cancellation against a runner's terminal
	// transition. Keep the running entry until the runner exits so cleanup and
	// worker capacity still reflect the live process.
	job, err := s.jobs.Cancel(ctx, id)
	if err != nil {
		return model.Job{}, err
	}
	if running, ok := s.running[id]; ok {
		running.cancel(nil)
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
		if errors.Is(err, model.ErrNoQueuedJob) {
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
		ctx, cancel := context.WithCancelCause(context.Background())
		s.mu.Lock()
		if s.stopped {
			cancel(ErrSchedulerStopped)
		}
		s.running[job.ID] = runningJob{cancel: cancel}
		s.mu.Unlock()
		current, getErr := s.jobs.Get(ctx, job.ID)
		if ctx.Err() != nil || getErr != nil || current.State != model.JobRunning {
			err = context.Canceled
		} else {
			err = s.runner(ctx, job)
		}
		s.mu.Lock()
		cancellation := context.Cause(ctx)
		delete(s.running, job.ID)
		s.mu.Unlock()
		if s.afterDeregister != nil {
			s.afterDeregister()
		}
		cancel(nil)
		s.finalize(job, err, cancellation)
	}
}

func (s *Scheduler) finalize(job model.Job, runnerErr, cancellation error) {
	started := time.Now()
	failed := false
	defer func() {
		if s.config.TerminalFinalization != nil {
			s.config.TerminalFinalization(time.Since(started), failed)
		}
	}()
	target, result, code := terminalTarget(runnerErr, cancellation)
	current, err := s.readTerminalState(job.ID)
	if err != nil {
		failed = true
		s.logTerminalFailure(job.ID, target, "terminal_state_read")
		return
	}
	if current.State != model.JobRunning {
		return
	}
	if _, err := s.persistTerminal(job.ID, target, result, code); err == nil {
		return
	}
	current, readErr := s.readTerminalState(job.ID)
	if readErr == nil && current.State != model.JobRunning {
		return
	}
	failed = true
	s.logTerminalFailure(job.ID, target, "terminal_transition")
}

func terminalTarget(runnerErr, cancellation error) (model.JobState, string, string) {
	// A published result still wins shutdown; an explicit cancellation has
	// already committed its terminal CAS and cannot be overwritten.
	if resultErr, ok := errors.AsType[*ResultPersistenceError](runnerErr); ok {
		return model.JobSucceeded, resultErr.Result, ""
	}
	if errors.Is(cancellation, ErrSchedulerStopped) {
		return model.JobFailed, "", "interrupted_by_restart"
	}
	if cancellation != nil {
		return model.JobCancelled, "", ""
	}
	if runnerErr == nil {
		return model.JobSucceeded, `{}`, ""
	}
	code := "job_failed"
	if errors.Is(runnerErr, ErrSourceChanged) {
		code = "source_changed"
	}
	return model.JobFailed, "", code
}

func (s *Scheduler) readTerminalState(id string) (model.Job, error) {
	var lastErr error
	for attempt := range terminalTransitionAttempts {
		ctx, cancel := context.WithTimeout(context.Background(), terminalTransitionTimeout)
		job, err := s.jobs.Get(ctx, id)
		cancel()
		if err == nil {
			return job, nil
		}
		lastErr = err
		if errors.Is(err, model.ErrJobNotFound) {
			break
		}
		if attempt+1 < terminalTransitionAttempts {
			time.Sleep(terminalTransitionBackoff)
		}
	}
	return model.Job{}, lastErr
}

func (s *Scheduler) persistTerminal(id string, target model.JobState, result, code string) (model.Job, error) {
	var lastErr error
	for attempt := range terminalTransitionAttempts {
		ctx, cancel := context.WithTimeout(context.Background(), terminalTransitionTimeout)
		job, err := s.applyTerminal(ctx, id, target, result, code)
		cancel()
		if err == nil {
			return job, nil
		}
		lastErr = err
		if errors.Is(err, model.ErrJobState) || errors.Is(err, model.ErrJobNotFound) {
			break
		}
		if attempt+1 < terminalTransitionAttempts {
			time.Sleep(terminalTransitionBackoff)
		}
	}
	return model.Job{}, lastErr
}

func (s *Scheduler) applyTerminal(ctx context.Context, id string, target model.JobState, result, code string) (model.Job, error) {
	if s.terminalTransition != nil {
		return s.terminalTransition(ctx, id, target, result, code)
	}
	switch target {
	case model.JobSucceeded:
		return s.jobs.Succeed(ctx, id, result)
	case model.JobFailed:
		return s.jobs.Fail(ctx, id, code)
	case model.JobCancelled:
		return s.jobs.Cancel(ctx, id)
	default:
		return model.Job{}, errors.New("unsupported terminal job state")
	}
}

func (s *Scheduler) logTerminalFailure(id string, target model.JobState, category string) {
	data, _ := json.Marshal(map[string]string{"event": "job_terminal_failure", "job_id": id, "target_state": string(target), "error_category": category})
	s.logger.Print(string(data))
}

type runningJob struct {
	cancel context.CancelCauseFunc
}

func (s *Scheduler) claim(ctx context.Context) (model.Job, error) {
	return s.jobs.storage.ClaimOldestQueued(ctx)
}

func (s *Scheduler) signal() {
	select {
	case s.wake <- struct{}{}:
	default:
	}
}
