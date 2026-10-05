package projects

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	cache "videocutlist/internal/preview/cache"
	"videocutlist/internal/projects/model"
)

type testCache struct{ *cache.Store }

func (c testCache) Open(ctx context.Context, key string, validator Validator) (io.ReadCloser, error) {
	return c.Store.Open(ctx, key, validator)
}
func (c testCache) Begin(key string) (PreviewPartial, error) { return c.Store.Begin(key) }

type bytesRunner []byte

func (r bytesRunner) Start(context.Context, model.PreviewSpec) (*RunningPreview, error) {
	return &RunningPreview{Stdout: io.NopCloser(bytes.NewReader(r)), Wait: func() error { return nil }}, nil
}

type closeTrackingReader struct {
	io.Reader
	closed bool
}

func (r *closeTrackingReader) Close() error {
	if r.closed {
		return errors.New("preview stdout already closed")
	}
	r.closed = true
	return nil
}

type waitClosesStdoutRunner []byte

func (r waitClosesStdoutRunner) Start(context.Context, model.PreviewSpec) (*RunningPreview, error) {
	stdout := &closeTrackingReader{Reader: bytes.NewReader(r)}
	return &RunningPreview{Stdout: stdout, Wait: stdout.Close}, nil
}

type blockingRunner struct {
	finished chan struct{}
}

type recordingPartial struct {
	PreviewPartial
	discarded chan struct{}
	once      sync.Once
}

func (p *recordingPartial) Discard() error {
	err := p.PreviewPartial.Discard()
	p.once.Do(func() { close(p.discarded) })
	return err
}

type recordingPreviewCache struct {
	store   *cache.Store
	partial *recordingPartial
}

func (c *recordingPreviewCache) Open(ctx context.Context, key string, validator Validator) (io.ReadCloser, error) {
	return c.store.Open(ctx, key, validator)
}
func (c *recordingPreviewCache) Begin(key string) (PreviewPartial, error) {
	partial, err := c.store.Begin(key)
	if err != nil {
		return nil, err
	}
	c.partial = &recordingPartial{PreviewPartial: partial, discarded: make(chan struct{})}
	return c.partial, nil
}

func (r *blockingRunner) Start(ctx context.Context, _ model.PreviewSpec) (*RunningPreview, error) {
	reader, writer := io.Pipe()
	done := make(chan error, 1)
	go func() {
		<-ctx.Done()
		_ = writer.CloseWithError(ctx.Err())
		done <- ctx.Err()
		if r.finished != nil {
			close(r.finished)
		}
	}()
	return &RunningPreview{Stdout: reader, Wait: func() error { return <-done }}, nil
}

func TestPreviewHitAndMissPublishAtomically(t *testing.T) {
	manager, _ := newManager(t, bytesRunner("preview"), 2)
	spec := testSpec("m_hit_miss")
	reader, result, err := manager.Preview(context.Background(), spec)
	if err != nil || result.Status != CacheMiss {
		t.Fatalf("miss = %v, %+v", err, result)
	}
	body, readErr := io.ReadAll(reader)
	_ = reader.Close()
	if readErr != nil || string(body) != "preview" {
		t.Fatalf("body = %q, %v", body, readErr)
	}
	hit, result, err := manager.Preview(context.Background(), spec)
	if err != nil || result.Status != CacheHit {
		t.Fatalf("hit = %v, %+v", err, result)
	}
	_ = hit.Close()
}

func TestPreviewWaitOwnsStdoutCloseAndPublishesCache(t *testing.T) {
	manager, _ := newManager(t, waitClosesStdoutRunner("preview"), 1)
	spec := testSpec("m_wait_closes_stdout")
	reader, result, err := manager.Preview(context.Background(), spec)
	if err != nil || result.Status != CacheMiss {
		t.Fatalf("miss = %v, %+v", err, result)
	}
	body, readErr := io.ReadAll(reader)
	if closeErr := reader.Close(); readErr != nil || closeErr != nil || string(body) != "preview" {
		t.Fatalf("body = %q, read=%v close=%v", body, readErr, closeErr)
	}
	hit, result, err := manager.Preview(context.Background(), spec)
	if err != nil || result.Status != CacheHit {
		t.Fatalf("hit = %v, %+v", err, result)
	}
	if err := hit.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestPreviewCancellationStopsProcessAndDiscardsPartial(t *testing.T) {
	runner := &blockingRunner{finished: make(chan struct{})}
	root := t.TempDir()
	store, err := cache.New(root, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	cacheRecorder := &recordingPreviewCache{store: store}
	limiter, err := NewPreviewLimits(1)
	if err != nil {
		t.Fatal(err)
	}
	manager, err := NewPreviewManager(cacheRecorder, runner, func(context.Context, *os.File) error { return nil }, limiter)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	reader, result, err := manager.Preview(ctx, testSpec("m_cancel"))
	if err != nil || result.Status != CacheMiss {
		t.Fatalf("preview = %v, %+v", err, result)
	}
	defer func() {
		cancel()
		_ = reader.Close()
		select {
		case <-cacheRecorder.partial.discarded:
		case <-time.After(time.Second):
			t.Error("preview partial cleanup did not finish")
		}
	}()
	cancel()
	_, readErr := io.ReadAll(reader)
	if !errors.Is(readErr, context.Canceled) {
		t.Fatalf("cancelled preview read = %v, want context.Canceled", readErr)
	}
	if err := reader.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-cacheRecorder.partial.discarded:
	case <-time.After(time.Second):
		t.Fatal("preview partial was not discarded")
	}
	select {
	case <-runner.finished:
	case <-time.After(time.Second):
		t.Fatal("preview process cleanup did not finish")
	}
	var files []string
	if err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !entry.IsDir() {
			files = append(files, path)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if len(files) != 0 {
		t.Fatalf("cancelled preview left cache files: %v", files)
	}
	key := model.PreviewKey(testSpec("m_cancel"))
	if hit, err := store.Open(context.Background(), key, func(context.Context, *os.File) error { return nil }); !errors.Is(err, cache.ErrMiss) {
		if hit != nil {
			_ = hit.Close()
		}
		t.Fatalf("cancelled cache = %v", err)
	}
	slotCtx, slotCancel := context.WithTimeout(t.Context(), time.Second)
	defer slotCancel()
	release, err := manager.limits.AcquireProcessContext(slotCtx)
	if err != nil {
		t.Fatalf("preview process slot was not released: %v", err)
	}
	release()
}

type failingPartial struct{}

func (failingPartial) Write([]byte) (int, error)               { return 0, errors.New("partial write failed") }
func (failingPartial) Commit(context.Context, Validator) error { return errors.New("unused") }
func (failingPartial) Discard() error                          { return nil }

type failingCache struct{}

func (failingCache) Open(context.Context, string, Validator) (io.ReadCloser, error) {
	return nil, ErrCacheMiss
}
func (failingCache) Begin(string) (PreviewPartial, error) { return failingPartial{}, nil }

type partialFailureRunner struct{}

func (partialFailureRunner) Start(ctx context.Context, _ model.PreviewSpec) (*RunningPreview, error) {
	return &RunningPreview{
		Stdout: io.NopCloser(bytes.NewReader([]byte("chunk"))),
		Wait: func() error {
			<-ctx.Done()
			return ctx.Err()
		},
	}, nil
}

func TestPreviewPartialWriteFailureStillReleasesProcess(t *testing.T) {
	runner := &partialFailureRunner{}
	limiter, err := NewPreviewLimits(1)
	if err != nil {
		t.Fatal(err)
	}
	manager, err := NewPreviewManager(failingCache{}, runner, func(context.Context, *os.File) error { return nil }, limiter)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
	defer cancel()
	reader, _, err := manager.Preview(ctx, testSpec("m_partial_fail"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = reader.Close() })
	readDone := make(chan error, 1)
	go func() {
		_, readErr := io.ReadAll(reader)
		readDone <- readErr
	}()
	select {
	case readErr := <-readDone:
		if readErr == nil {
			t.Fatal("partial-write failure was not surfaced to the reader")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("preview reader hung after a partial-write failure")
	}
	_ = reader.Close()
	second, _, err := manager.Preview(ctx, testSpec("m_second"))
	if err != nil {
		t.Fatalf("process slot leaked after partial-write failure: %v", err)
	}
	_ = second.Close()
}

func newManager(t *testing.T, runner PreviewRunner, global int) (*PreviewManager, *cache.Store) {
	t.Helper()
	store, err := cache.New(t.TempDir(), 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	limiter, err := NewPreviewLimits(global)
	if err != nil {
		t.Fatal(err)
	}
	validator := func(_ context.Context, file *os.File) error {
		info, err := file.Stat()
		if err != nil || info.Size() == 0 {
			return errors.New("invalid")
		}
		return nil
	}
	manager, err := NewPreviewManager(testCache{store}, runner, validator, limiter)
	if err != nil {
		t.Fatal(err)
	}
	return manager, store
}

func testSpec(id string) model.PreviewSpec {
	return model.PreviewSpec{MediaID: id, SizeBytes: 1, MtimeNS: 2, StartMS: 3, DurationMS: 4, Width: 1280, Height: 720, FPS: 30, Audio: true, Encoder: "software-h264-v1"}
}
