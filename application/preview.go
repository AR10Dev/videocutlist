package application

import (
	"context"
	"errors"
	"io"
	"sync"

	"editapp/domain"
)

type CacheStatus string

const (
	CacheHit       CacheStatus = "hit"
	CacheMiss      CacheStatus = "miss"
	CacheShared    CacheStatus = "shared"
	maxReplayBytes             = 64 << 20
)

var ErrReplayLimit = errors.New("preview replay limit exceeded")
var ErrCacheMiss = domain.ErrCacheMiss

type Validator = func(context.Context, string) error
type PreviewPartial interface {
	io.Writer
	Commit(context.Context, Validator) error
	Discard() error
}
type PreviewCache interface {
	Open(context.Context, string, Validator) (io.ReadCloser, error)
	Begin(string) (PreviewPartial, error)
}
type RunningPreview struct {
	Stdout io.ReadCloser
	PID    int
	Wait   func() error
}
type PreviewRunner interface {
	Start(context.Context, domain.PreviewSpec) (*RunningPreview, error)
}

type Result struct {
	Key    string
	Status CacheStatus
}

type PreviewManager struct {
	cache     PreviewCache
	runner    PreviewRunner
	validator Validator
	limits    *PreviewLimits
	maxReplay int64

	mu     sync.Mutex
	jobs   map[string]*previewJob
	byUser map[string]*subscriber
}

func NewPreviewManager(store PreviewCache, runner PreviewRunner, validator Validator, limiter *PreviewLimits) (*PreviewManager, error) {
	if store == nil || runner == nil || validator == nil || limiter == nil {
		return nil, errors.New("cache, runner, validator, and limiter are required")
	}
	return &PreviewManager{cache: store, runner: runner, validator: validator, limits: limiter, maxReplay: maxReplayBytes, jobs: make(map[string]*previewJob), byUser: make(map[string]*subscriber)}, nil
}

// Preview returns an immediate reader. Closing it, or cancelling ctx, detaches
// only this subscriber; the process ends once no subscriber remains.
func (m *PreviewManager) Preview(ctx context.Context, user string, spec domain.PreviewSpec) (io.ReadCloser, Result, error) {
	if user == "" {
		return nil, Result{}, errors.New("preview user is required")
	}
	key := domain.PreviewKey(spec)
	if reader, ok := m.replaceSameKey(ctx, user, key); ok {
		return reader, Result{Key: key, Status: CacheShared}, nil
	}
	m.supersede(user)
	releaseUser, err := m.limits.AcquireUser(user)
	if err != nil {
		return nil, Result{}, err
	}
	if hit, err := m.cache.Open(ctx, key, m.validator); err == nil {
		return &limitedReader{ReadCloser: hit, release: releaseUser}, Result{Key: key, Status: CacheHit}, nil
	} else if !errors.Is(err, ErrCacheMiss) {
		releaseUser()
		return nil, Result{}, err
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	if job := m.jobs[key]; job != nil {
		return m.subscribeLocked(ctx, user, job, releaseUser), Result{Key: key, Status: CacheShared}, nil
	}
	releaseProcess, err := m.limits.AcquireProcess()
	if err != nil {
		releaseUser()
		return nil, Result{}, err
	}
	partial, err := m.cache.Begin(key)
	if err != nil {
		releaseProcess()
		releaseUser()
		return nil, Result{}, err
	}
	jobCtx, cancel := context.WithCancel(context.Background())
	running, err := m.runner.Start(jobCtx, spec)
	if err != nil {
		cancel()
		_ = partial.Discard()
		releaseProcess()
		releaseUser()
		return nil, Result{}, err
	}
	job := &previewJob{manager: m, key: key, ctx: jobCtx, cancel: cancel, running: running, partial: partial, release: releaseProcess, subscribers: make(map[*subscriber]struct{}), finished: make(chan struct{})}
	job.cond = sync.NewCond(&job.mu)
	m.jobs[key] = job
	reader := m.subscribeLocked(ctx, user, job, releaseUser)
	go job.run()
	return reader, Result{Key: key, Status: CacheMiss}, nil
}

// replaceSameKey preserves the single-flight when a user's newer foreground
// request normalizes to the same preview. The old HTTP stream is detached and
// the new one replays the process's chunks from the beginning.
func (m *PreviewManager) replaceSameKey(ctx context.Context, user, key string) (io.ReadCloser, bool) {
	m.mu.Lock()
	old := m.byUser[user]
	if old == nil || old.job.key != key {
		m.mu.Unlock()
		return nil, false
	}
	job := old.job
	job.mu.Lock()
	delete(job.subscribers, old)
	job.cond.Broadcast()
	old.release()
	release, err := m.limits.AcquireUser(user)
	if err != nil {
		job.mu.Unlock()
		m.mu.Unlock()
		return nil, false
	}
	reader, writer := io.Pipe()
	sub := &subscriber{manager: m, job: job, user: user, reader: reader, writer: writer, detached: make(chan struct{}), copyDone: make(chan struct{}), release: release}
	job.subscribers[sub] = struct{}{}
	m.byUser[user] = sub
	close(old.detached)
	job.mu.Unlock()
	m.mu.Unlock()
	_ = old.writer.CloseWithError(context.Canceled)
	go sub.copy()
	go func() {
		select {
		case <-ctx.Done():
			sub.job.remove(sub, ctx.Err())
		case <-sub.detached:
		}
	}()
	return sub, true
}

func (m *PreviewManager) supersede(user string) {
	m.mu.Lock()
	old := m.byUser[user]
	m.mu.Unlock()
	if old != nil {
		old.job.remove(old, context.Canceled)
	}
}

func (m *PreviewManager) subscribeLocked(ctx context.Context, user string, job *previewJob, release func()) io.ReadCloser {
	reader, writer := io.Pipe()
	sub := &subscriber{manager: m, job: job, user: user, reader: reader, writer: writer, detached: make(chan struct{}), copyDone: make(chan struct{}), release: release}
	job.mu.Lock()
	job.subscribers[sub] = struct{}{}
	job.mu.Unlock()
	m.byUser[user] = sub
	go sub.copy()
	go func() {
		select {
		case <-ctx.Done():
			sub.job.remove(sub, ctx.Err())
		case <-sub.detached:
		}
	}()
	return sub
}

type previewJob struct {
	manager *PreviewManager
	key     string
	ctx     context.Context
	cancel  context.CancelFunc
	running *RunningPreview
	partial PreviewPartial
	release func()

	mu          sync.Mutex
	cond        *sync.Cond
	chunks      [][]byte
	replayBytes int64
	done        bool
	err         error
	subscribers map[*subscriber]struct{}
	finished    chan struct{}
}

func (j *previewJob) run() {
	defer j.release()
	defer j.running.Stdout.Close()
	buf := make([]byte, 32*1024)
	var copyErr error
	for {
		n, err := j.running.Stdout.Read(buf)
		if n > 0 {
			chunk := append([]byte(nil), buf[:n]...)
			j.mu.Lock()
			if j.replayBytes+int64(n) > j.manager.maxReplay {
				copyErr = ErrReplayLimit
				j.cancel()
				j.mu.Unlock()
				break
			}
			j.replayBytes += int64(n)
			j.chunks = append(j.chunks, chunk)
			j.cond.Broadcast()
			j.mu.Unlock()
			if _, writeErr := j.partial.Write(chunk); writeErr != nil && copyErr == nil {
				copyErr = writeErr
				j.cancel()
			}
		}
		if err != nil {
			if !errors.Is(err, io.EOF) && copyErr == nil {
				copyErr = err
			}
			break
		}
	}
	waitErr := j.running.Wait() // Required exactly once by contracts.RunningPreview.
	if copyErr == nil && waitErr != nil {
		copyErr = waitErr
	}
	if copyErr == nil && j.ctx.Err() == nil {
		copyErr = j.partial.Commit(j.ctx, j.manager.validator)
	} else {
		_ = j.partial.Discard()
		if copyErr == nil {
			copyErr = j.ctx.Err()
		}
	}
	j.finish(copyErr)
}

func (j *previewJob) finish(err error) {
	j.manager.mu.Lock()
	j.mu.Lock()
	j.done, j.err = true, err
	if len(j.subscribers) == 0 {
		j.chunks = nil
		j.replayBytes = 0
	}
	j.cond.Broadcast()
	j.mu.Unlock()
	delete(j.manager.jobs, j.key)
	j.manager.mu.Unlock()
	close(j.finished)
}

func (j *previewJob) remove(sub *subscriber, reason error) {
	j.manager.mu.Lock()
	j.mu.Lock()
	if _, ok := j.subscribers[sub]; !ok {
		j.mu.Unlock()
		j.manager.mu.Unlock()
		return
	}
	delete(j.subscribers, sub)
	close(sub.detached)
	sub.release()
	empty := len(j.subscribers) == 0
	if empty {
		j.chunks = nil
		j.replayBytes = 0
	}
	cancel := empty && !j.done
	j.cond.Broadcast()
	j.mu.Unlock()
	if j.manager.byUser[sub.user] == sub {
		delete(j.manager.byUser, sub.user)
	}
	j.manager.mu.Unlock()
	_ = sub.writer.CloseWithError(reason)
	if cancel {
		j.cancel()
	}
}

type subscriber struct {
	manager  *PreviewManager
	job      *previewJob
	user     string
	reader   *io.PipeReader
	writer   *io.PipeWriter
	detached chan struct{}
	copyDone chan struct{}
	once     sync.Once
	release  func()
}

func (s *subscriber) Read(p []byte) (int, error) { return s.reader.Read(p) }
func (s *subscriber) Close() error {
	err := s.reader.Close()
	s.once.Do(func() { s.job.remove(s, context.Canceled) })
	return err
}

type limitedReader struct {
	io.ReadCloser
	once    sync.Once
	release func()
}

func (r *limitedReader) Close() error {
	err := r.ReadCloser.Close()
	r.once.Do(r.release)
	return err
}

func (s *subscriber) copy() {
	defer close(s.copyDone)
	for cursor := 0; ; {
		s.job.mu.Lock()
		for cursor == len(s.job.chunks) && !s.job.done {
			if _, ok := s.job.subscribers[s]; !ok {
				s.job.mu.Unlock()
				return
			}
			s.job.cond.Wait()
		}
		if _, ok := s.job.subscribers[s]; !ok {
			s.job.mu.Unlock()
			return
		}
		if cursor < len(s.job.chunks) {
			chunk := s.job.chunks[cursor]
			cursor++
			s.job.mu.Unlock()
			if _, err := s.writer.Write(chunk); err != nil {
				s.job.remove(s, err)
				return
			}
			continue
		}
		err := s.job.err
		s.job.mu.Unlock()
		_ = s.writer.CloseWithError(err)
		return
	}
}
