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

	"editapp/domain"
	cache "editapp/infrastructure/cache"
)

type bytesRunner []byte

type testCache struct{ *cache.Store }

func (c testCache) Open(ctx context.Context, key string, validator Validator) (io.ReadCloser, error) {
	return c.Store.Open(ctx, key, cache.Validator(validator))
}
func (c testCache) Begin(key string) (PreviewPartial, error) { return c.Store.Begin(key) }

func (r bytesRunner) Start(context.Context, domain.PreviewSpec) (*RunningPreview, error) {
	return &RunningPreview{
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

func (r *testRunner) Start(ctx context.Context, _ domain.PreviewSpec) (*RunningPreview, error) {
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
	return &RunningPreview{Stdout: reader, Wait: func() error { return <-done }}, nil
}

func (r *testRunner) counts() (int, int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.starts, r.cancels
}

type cancellationReplayRunner struct{ starts int }

func (r *cancellationReplayRunner) Start(ctx context.Context, spec domain.PreviewSpec) (*RunningPreview, error) {
	r.starts++
	if r.starts > 1 {
		return bytesRunner("preview").Start(ctx, spec)
	}
	reader, writer := io.Pipe()
	done := make(chan error, 1)
	go func() {
		_, _ = writer.Write([]byte("first"))
		<-ctx.Done()
		_, _ = writer.Write([]byte("late"))
		_ = writer.CloseWithError(ctx.Err())
		done <- ctx.Err()
	}()
	return &RunningPreview{Stdout: reader, Wait: func() error { return <-done }}, nil
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
	if _, _, err := manager.Preview(context.Background(), "b", testSpec("m_b")); !errors.Is(err, ErrGlobalLimit) {
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

func eventuallyReplacement(t *testing.T, manager *PreviewManager, user string, spec domain.PreviewSpec) (io.ReadCloser, Result, error) {
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

func TestFinishedPreviewRetainsSlowSubscriberQuota(t *testing.T) {
	manager := newManagerWithRunner(t, bytesRunner("preview"), 1, 1)
	spec := testSpec("m_slow")
	reader, result, err := manager.Preview(context.Background(), "a", spec)
	if err != nil || result.Status != CacheMiss {
		t.Fatalf("preview = %v, %+v", err, result)
	}
	defer reader.Close()

	manager.mu.Lock()
	sub := manager.byUser["a"]
	manager.mu.Unlock()
	if sub == nil {
		t.Fatal("slow subscriber was not registered")
	}
	select {
	case <-sub.job.finished:
	case <-time.After(time.Second):
		t.Fatal("preview did not finish")
	}

	manager.mu.Lock()
	registered := manager.byUser["a"] == sub
	manager.mu.Unlock()
	if !registered {
		t.Fatal("finished preview released slow subscriber registration")
	}
	if release, err := manager.limits.AcquireUser("a"); !errors.Is(err, ErrUserLimit) {
		if release != nil {
			release()
		}
		t.Fatalf("slow subscriber quota = %v, want %v", err, ErrUserLimit)
	}

	replacement, result, err := manager.Preview(context.Background(), "a", spec)
	if err != nil || result.Status != CacheShared {
		t.Fatalf("replacement = %v, %+v", err, result)
	}
	_ = replacement.Close()
}

func TestFinishedPreviewContextCancellationDetachesSubscriber(t *testing.T) {
	manager := newManagerWithRunner(t, bytesRunner("preview"), 1, 1)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	reader, result, err := manager.Preview(ctx, "a", testSpec("m_context"))
	if err != nil || result.Status != CacheMiss {
		t.Fatalf("preview = %v, %+v", err, result)
	}
	defer reader.Close()

	manager.mu.Lock()
	sub := manager.byUser["a"]
	manager.mu.Unlock()
	if sub == nil {
		t.Fatal("subscriber was not registered")
	}
	select {
	case <-sub.job.finished:
	case <-time.After(time.Second):
		t.Fatal("preview did not finish")
	}
	cancel()
	select {
	case <-sub.detached:
	case <-time.After(time.Second):
		t.Fatal("context cancellation did not detach subscriber")
	}

	manager.mu.Lock()
	registered := manager.byUser["a"] == sub
	manager.mu.Unlock()
	if registered {
		t.Fatal("cancelled subscriber remained registered")
	}
	sub.job.mu.Lock()
	chunks, replayBytes := len(sub.job.chunks), sub.job.replayBytes
	sub.job.mu.Unlock()
	if chunks != 0 || replayBytes != 0 {
		t.Fatalf("cancelled replay = %d chunks, %d bytes", chunks, replayBytes)
	}
	if release, err := manager.limits.AcquireUser("a"); err != nil {
		t.Fatalf("cancelled subscriber quota = %v", err)
	} else {
		release()
	}
}

func TestSameKeyReplacementStopsStalledCopy(t *testing.T) {
	runner := newTestRunner()
	manager := newManager(t, runner, 1, 1)
	spec := testSpec("m_stalled")
	first, result, err := manager.Preview(context.Background(), "a", spec)
	if err != nil || result.Status != CacheMiss {
		t.Fatalf("first = %v, %+v", err, result)
	}
	defer first.Close()
	manager.mu.Lock()
	old := manager.byUser["a"]
	manager.mu.Unlock()

	second, result, err := manager.Preview(context.Background(), "a", spec)
	if err != nil || result.Status != CacheShared {
		t.Fatalf("replacement = %v, %+v", err, result)
	}
	select {
	case <-old.copyDone:
	case <-time.After(time.Second):
		t.Fatal("detached copy did not stop")
	}
	if err := second.Close(); err != nil {
		t.Fatal(err)
	}
	awaitCancel(t, runner)
}

func TestSupersededPreviewDropsReplay(t *testing.T) {
	manager := newManagerWithRunner(t, &cancellationReplayRunner{}, 2, 1)
	first, result, err := manager.Preview(context.Background(), "a", testSpec("m_first"))
	if err != nil || result.Status != CacheMiss {
		t.Fatalf("first = %v, %+v", err, result)
	}
	defer first.Close()

	manager.mu.Lock()
	job := manager.byUser["a"].job
	manager.mu.Unlock()
	second, result, err := manager.Preview(context.Background(), "a", testSpec("m_second"))
	if err != nil || result.Status != CacheMiss {
		t.Fatalf("second = %v, %+v", err, result)
	}
	defer second.Close()
	select {
	case <-job.finished:
	case <-time.After(time.Second):
		t.Fatal("superseded preview did not finish")
	}

	job.mu.Lock()
	chunks, replayBytes := len(job.chunks), job.replayBytes
	job.mu.Unlock()
	if chunks != 0 || replayBytes != 0 {
		t.Fatalf("detached replay = %d chunks, %d bytes", chunks, replayBytes)
	}
}

func newManager(t *testing.T, runner *testRunner, global, perUser int) *PreviewManager {
	return newManagerWithRunner(t, runner, global, perUser)
}

func newManagerWithRunner(t *testing.T, runner PreviewRunner, global, perUser int) *PreviewManager {
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
	return manager
}

func testSpec(id string) domain.PreviewSpec {
	return domain.PreviewSpec{MediaID: id, SizeBytes: 1, MtimeNS: 2, StartMS: 3, DurationMS: 4, Width: 1280, Height: 720, FPS: 30, Audio: true, Encoder: "software-h264-v1"}
}
