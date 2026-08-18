package application

import (
	"context"
	"errors"
	"io"
	"sync"

	"videocutlist/domain"
)

type CacheStatus string

const (
	CacheHit  CacheStatus = "hit"
	CacheMiss CacheStatus = "miss"
)

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
}

func NewPreviewManager(store PreviewCache, runner PreviewRunner, validator Validator, limiter *PreviewLimits) (*PreviewManager, error) {
	if store == nil || runner == nil || validator == nil || limiter == nil {
		return nil, errors.New("cache, runner, validator, and limiter are required")
	}
	return &PreviewManager{cache: store, runner: runner, validator: validator, limits: limiter}, nil
}

// Preview streams a cache hit directly. A miss starts exactly one FFmpeg
// process for this request; cancellation or a closed reader discards output.
func (m *PreviewManager) Preview(ctx context.Context, user string, spec domain.PreviewSpec) (io.ReadCloser, Result, error) {
	if user == "" {
		return nil, Result{}, errors.New("preview user is required")
	}
	key := domain.PreviewKey(spec)
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
	reader, writer := io.Pipe()
	runCtx, cancel := context.WithCancel(ctx)
	running, err := m.runner.Start(runCtx, spec)
	if err != nil {
		cancel()
		_ = partial.Discard()
		releaseProcess()
		releaseUser()
		_ = reader.Close()
		return nil, Result{}, err
	}
	go streamPreview(runCtx, cancel, running, partial, writer, m.validator, releaseProcess, releaseUser)
	return &previewReader{ReadCloser: reader, cancel: cancel}, Result{Key: key, Status: CacheMiss}, nil
}

func streamPreview(ctx context.Context, cancel context.CancelFunc, running *RunningPreview, partial PreviewPartial, writer *io.PipeWriter, validator Validator, releaseProcess, releaseUser func()) {
	defer releaseProcess()
	defer releaseUser()
	defer running.Stdout.Close()
	defer cancel()
	go func() {
		<-ctx.Done()
		_ = writer.CloseWithError(ctx.Err())
	}()

	buf := make([]byte, 32*1024)
	var streamErr error
	for streamErr == nil {
		n, err := running.Stdout.Read(buf)
		if n > 0 {
			if _, streamErr = partial.Write(buf[:n]); streamErr == nil {
				_, streamErr = writer.Write(buf[:n])
			}
		}
		if err != nil {
			if !errors.Is(err, io.EOF) && streamErr == nil {
				streamErr = err
			}
			break
		}
	}
	waitErr := running.Wait()
	if streamErr == nil && waitErr != nil {
		streamErr = waitErr
	}
	if streamErr == nil && ctx.Err() == nil {
		streamErr = partial.Commit(ctx, validator)
	} else {
		_ = partial.Discard()
		if streamErr == nil {
			streamErr = ctx.Err()
		}
	}
	_ = writer.CloseWithError(streamErr)
}

type previewReader struct {
	io.ReadCloser
	cancel func()
	once   sync.Once
}

func (r *previewReader) Close() error {
	r.once.Do(r.cancel)
	return r.ReadCloser.Close()
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
