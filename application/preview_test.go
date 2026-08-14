package application

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"sync"
	"testing"
	"time"

	"videocutlist/domain"
	cache "videocutlist/infrastructure/cache"
)

type testCache struct{ *cache.Store }

func (c testCache) Open(ctx context.Context, key string, validator Validator) (io.ReadCloser, error) {
	return c.Store.Open(ctx, key, cache.Validator(validator))
}
func (c testCache) Begin(key string) (PreviewPartial, error) { return c.Store.Begin(key) }

type bytesRunner []byte

func (r bytesRunner) Start(context.Context, domain.PreviewSpec) (*RunningPreview, error) {
	return &RunningPreview{Stdout: io.NopCloser(bytes.NewReader(r)), Wait: func() error { return nil }}, nil
}

type blockingRunner struct {
	mu      sync.Mutex
	starts  int
	cancels int
}

func (r *blockingRunner) Start(ctx context.Context, _ domain.PreviewSpec) (*RunningPreview, error) {
	r.mu.Lock()
	r.starts++
	r.mu.Unlock()
	reader, writer := io.Pipe()
	done := make(chan error, 1)
	go func() {
		<-ctx.Done()
		r.mu.Lock()
		r.cancels++
		r.mu.Unlock()
		_ = writer.CloseWithError(ctx.Err())
		done <- ctx.Err()
	}()
	return &RunningPreview{Stdout: reader, Wait: func() error { return <-done }}, nil
}

func TestPreviewHitAndMissPublishAtomically(t *testing.T) {
	manager, _ := newManager(t, bytesRunner("preview"), 2, 2)
	spec := testSpec("m_hit_miss")
	reader, result, err := manager.Preview(context.Background(), "a", spec)
	if err != nil || result.Status != CacheMiss {
		t.Fatalf("miss = %v, %+v", err, result)
	}
	body, readErr := io.ReadAll(reader)
	_ = reader.Close()
	if readErr != nil || string(body) != "preview" {
		t.Fatalf("body = %q, %v", body, readErr)
	}
	hit, result, err := manager.Preview(context.Background(), "b", spec)
	if err != nil || result.Status != CacheHit {
		t.Fatalf("hit = %v, %+v", err, result)
	}
	_ = hit.Close()
}

func TestPreviewCancellationStopsProcessAndDiscardsPartial(t *testing.T) {
	runner := &blockingRunner{}
	manager, store := newManager(t, runner, 1, 1)
	ctx, cancel := context.WithCancel(context.Background())
	reader, result, err := manager.Preview(ctx, "a", testSpec("m_cancel"))
	if err != nil || result.Status != CacheMiss {
		t.Fatalf("preview = %v, %+v", err, result)
	}
	cancel()
	_, _ = io.ReadAll(reader)
	_ = reader.Close()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		runner.mu.Lock()
		cancels := runner.cancels
		runner.mu.Unlock()
		if cancels == 1 {
			break
		}
		time.Sleep(time.Millisecond)
	}
	runner.mu.Lock()
	if runner.cancels != 1 {
		t.Fatalf("cancels = %d", runner.cancels)
	}
	runner.mu.Unlock()
	key := domain.PreviewKey(testSpec("m_cancel"))
	if hit, err := store.Open(context.Background(), key, cache.ValidatorFunc(func(context.Context, string) error { return nil })); !errors.Is(err, cache.ErrMiss) {
		if hit != nil {
			_ = hit.Close()
		}
		t.Fatalf("cancelled cache = %v", err)
	}
}

func newManager(t *testing.T, runner PreviewRunner, global, perUser int) (*PreviewManager, *cache.Store) {
	t.Helper()
	store, err := cache.New(t.TempDir(), 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	limiter, err := NewPreviewLimits(global, perUser)
	if err != nil {
		t.Fatal(err)
	}
	validator := cache.ValidatorFunc(func(_ context.Context, path string) error {
		info, err := os.Stat(path)
		if err != nil || info.Size() == 0 {
			return errors.New("invalid")
		}
		return nil
	})
	manager, err := NewPreviewManager(testCache{store}, runner, Validator(validator), limiter)
	if err != nil {
		t.Fatal(err)
	}
	return manager, store
}

func testSpec(id string) domain.PreviewSpec {
	return domain.PreviewSpec{MediaID: id, SizeBytes: 1, MtimeNS: 2, StartMS: 3, DurationMS: 4, Width: 1280, Height: 720, FPS: 30, Audio: true, Encoder: "software-h264-v1"}
}
