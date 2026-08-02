package jobs

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"sync"
	"testing"
	"time"

	"editapp/internal/cache"
	"editapp/internal/contracts"
	"editapp/internal/limits"
)

type bytesRunner []byte

func (r bytesRunner) Start(context.Context, contracts.PreviewSpec) (*contracts.RunningPreview, error) {
	return &contracts.RunningPreview{
		Stdout: io.NopCloser(bytes.NewReader(r)),
		Wait:   func() error { return nil },
	}, nil
}

type testRunner struct {
	mu      sync.Mutex
	starts  int
	cancels int
	gate    chan struct{}
	cancel  chan struct{}
}

func (r *testRunner) Start(ctx context.Context, _ contracts.PreviewSpec) (*contracts.RunningPreview, error) {
	r.mu.Lock()
	r.starts++
	r.mu.Unlock()
	reader, writer := io.Pipe()
	done := make(chan error, 1)
	go func() {
		select {
		case <-r.gate:
			_, _ = writer.Write([]byte("preview"))
			_ = writer.Close()
			done <- nil
		case <-ctx.Done():
			r.mu.Lock()
			r.cancels++
			r.mu.Unlock()
			select {
			case r.cancel <- struct{}{}:
			default:
			}
			_ = writer.CloseWithError(ctx.Err())
			done <- ctx.Err()
		}
	}()
	return &contracts.RunningPreview{Stdout: reader, Wait: func() error { return <-done }}, nil
}

func (r *testRunner) counts() (int, int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.starts, r.cancels
}

func TestDuplicateRequestsShareRunnerAndPublishCache(t *testing.T) {
	runner := newTestRunner()
	manager := newManager(t, runner, 1, 1)
	spec := testSpec("m_a")
	one, result, err := manager.Preview(context.Background(), "a", spec)
	if err != nil || result.Status != CacheMiss {
		t.Fatalf("first = %v, %+v", err, result)
	}
	two, result, err := manager.Preview(context.Background(), "b", spec)
	if err != nil || result.Status != CacheShared {
		t.Fatalf("second = %v, %+v", err, result)
	}
	close(runner.gate)
	for _, reader := range []io.ReadCloser{one, two} {
		body, err := io.ReadAll(reader)
		_ = reader.Close()
		if err != nil || string(body) != "preview" {
			t.Fatalf("body = %q, %v", body, err)
		}
	}
	hit, result, err := manager.Preview(context.Background(), "c", spec)
	if err != nil || result.Status != CacheHit {
		t.Fatalf("cache hit = %v, %+v", err, result)
	}
	_ = hit.Close()
	if starts, _ := runner.counts(); starts != 1 {
		t.Fatalf("starts = %d", starts)
	}
}

func TestCancellationRemovesPartialAndSupersedes(t *testing.T) {
	runner := newTestRunner()
	manager := newManager(t, runner, 1, 1)
	spec := testSpec("m_first")
	first, _, err := manager.Preview(context.Background(), "a", spec)
	if err != nil {
		t.Fatal(err)
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	awaitCancel(t, runner)
	second, result, err := eventuallyReplacement(t, manager, "a", spec)
	if err != nil || result.Status != CacheMiss {
		t.Fatalf("replacement = %v, %+v", err, result)
	}
	_ = second.Close()
}

func TestSameUserSameKeyStillSharesRunner(t *testing.T) {
	runner := newTestRunner()
	manager := newManager(t, runner, 1, 1)
	first, _, err := manager.Preview(context.Background(), "a", testSpec("m_same"))
	if err != nil {
		t.Fatal(err)
	}
	second, result, err := manager.Preview(context.Background(), "a", testSpec("m_same"))
	if err != nil || result.Status != CacheShared {
		t.Fatalf("second = %v, %+v", err, result)
	}
	close(runner.gate)
	if body, err := io.ReadAll(second); err != nil || string(body) != "preview" {
		t.Fatalf("body = %q, %v", body, err)
	}
	_ = first.Close()
	_ = second.Close()
	if starts, _ := runner.counts(); starts != 1 {
		t.Fatalf("starts = %d", starts)
	}
}

func TestSupersedingSharedJobStartsNewKeyImmediately(t *testing.T) {
	runner := newTestRunner()
	manager := newManager(t, runner, 2, 1)
	first, _, err := manager.Preview(context.Background(), "a", testSpec("m_first"))
	if err != nil {
		t.Fatal(err)
	}
	shared, result, err := manager.Preview(context.Background(), "b", testSpec("m_first"))
	if err != nil || result.Status != CacheShared {
		t.Fatalf("shared = %v, %+v", err, result)
	}
	second, result, err := manager.Preview(context.Background(), "a", testSpec("m_second"))
	if err != nil || result.Status != CacheMiss {
		t.Fatalf("superseding request = %v, %+v", err, result)
	}
	if starts, cancels := runner.counts(); starts != 2 || cancels != 0 {
		t.Fatalf("starts, cancels = %d, %d; old shared job must remain active", starts, cancels)
	}
	close(runner.gate)
	if body, err := io.ReadAll(shared); err != nil || string(body) != "preview" {
		t.Fatalf("shared body = %q, %v", body, err)
	}
	if body, err := io.ReadAll(second); err != nil || string(body) != "preview" {
		t.Fatalf("replacement body = %q, %v", body, err)
	}
	_ = first.Close()
	_ = shared.Close()
	_ = second.Close()
}

func TestLimitFailure(t *testing.T) {
	runner := newTestRunner()
	manager := newManager(t, runner, 1, 1)
	first, _, err := manager.Preview(context.Background(), "a", testSpec("m_a"))
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := manager.Preview(context.Background(), "b", testSpec("m_b")); !errors.Is(err, limits.ErrGlobalLimit) {
		t.Fatalf("limit error = %v", err)
	}
	_ = first.Close()
}

func newTestRunner() *testRunner {
	return &testRunner{gate: make(chan struct{}), cancel: make(chan struct{}, 2)}
}

func awaitCancel(t *testing.T, runner *testRunner) {
	t.Helper()
	select {
	case <-runner.cancel:
	case <-time.After(time.Second):
		t.Fatal("runner was not cancelled")
	}
}

func eventuallyReplacement(t *testing.T, manager *PreviewManager, user string, spec contracts.PreviewSpec) (io.ReadCloser, Result, error) {
	t.Helper()
	deadline := time.NewTimer(time.Second)
	defer deadline.Stop()
	tick := time.NewTicker(time.Millisecond)
	defer tick.Stop()
	for {
		reader, result, err := manager.Preview(context.Background(), user, spec)
		if err == nil && result.Status != CacheShared {
			return reader, result, nil
		}
		if reader != nil {
			_ = reader.Close()
		}
		select {
		case <-deadline.C:
			return nil, Result{}, errors.New("replacement did not begin")
		case <-tick.C:
		}
	}
}

func TestReplayBufferLimitCancelsPreview(t *testing.T) {
	manager := newManagerWithRunner(t, bytesRunner("too large"), 1, 1)
	manager.maxReplay = 4
	reader, _, err := manager.Preview(context.Background(), "a", testSpec("m_large"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.ReadAll(reader); !errors.Is(err, ErrReplayLimit) {
		t.Fatalf("read error = %v", err)
	}
	_ = reader.Close()
}

func newManager(t *testing.T, runner *testRunner, global, perUser int) *PreviewManager {
	return newManagerWithRunner(t, runner, global, perUser)
}

func newManagerWithRunner(t *testing.T, runner contracts.PreviewRunner, global, perUser int) *PreviewManager {
	t.Helper()
	store, err := cache.New(t.TempDir(), 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	limiter, err := limits.NewPreview(global, perUser)
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
	manager, err := NewPreviewManager(store, runner, validator, limiter)
	if err != nil {
		t.Fatal(err)
	}
	return manager
}

func testSpec(id string) contracts.PreviewSpec {
	return contracts.PreviewSpec{MediaID: id, SizeBytes: 1, MtimeNS: 2, StartMS: 3, DurationMS: 4, Width: 1280, Height: 720, FPS: 30, Audio: true, Encoder: "software-h264-v1"}
}
