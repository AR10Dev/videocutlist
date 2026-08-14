package cache

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"

	"videocutlist/domain"
)

var accept = ValidatorFunc(func(_ context.Context, path string) error {
	info, err := os.Stat(path)
	if err != nil || info.Size() == 0 {
		return errors.New("invalid preview")
	}
	return nil
})

func TestKeyAndPathAreFrozen(t *testing.T) {
	spec := domain.PreviewSpec{MediaID: "m_test", SizeBytes: 3, MtimeNS: 4, StartMS: 5, DurationMS: 6, Width: 1280, Height: 720, FPS: 30, Audio: true, Encoder: "software-h264-v1"}
	if got, want := Key(spec), "9fd5a59c541b3e2faab0b0c8a72daf70b258cfbfc6adfe6b2ae65024fece9f5f"; got != want {
		t.Fatalf("key = %s, want %s", got, want)
	}
	path, err := RelativePath(Key(spec))
	if err != nil || path != filepath.Join("previews", "9f", "d5", Key(spec)+".mp4") {
		t.Fatalf("path = %q, %v", path, err)
	}
}

func TestCommitOpenAndEvict(t *testing.T) {
	store, err := New(t.TempDir(), 3)
	if err != nil {
		t.Fatal(err)
	}
	key1, key2 := stringsOf('1'), stringsOf('2')
	writePartial(t, store, key1, "one")
	reader, err := store.Open(context.Background(), key1, accept)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	if b, _ := io.ReadAll(reader); string(b) != "one" {
		t.Fatalf("got %q", b)
	}
	writePartial(t, store, key2, "two")
	if _, err := store.Open(context.Background(), key1, accept); err != nil {
		t.Fatalf("leased entry was evicted: %v", err)
	}
	if _, err := store.Open(context.Background(), key2, accept); !errors.Is(err, ErrMiss) {
		t.Fatalf("new entry error = %v, want miss after bounded eviction", err)
	}
}

func TestOpenDoesNotLockDuringValidation(t *testing.T) {
	store, err := New(t.TempDir(), 1024)
	if err != nil {
		t.Fatal(err)
	}
	key1, key2 := stringsOf('6'), stringsOf('7')
	writePartial(t, store, key1, "one")
	writePartial(t, store, key2, "two")
	started := make(chan struct{})
	release := make(chan struct{})
	firstOpened := make(chan error, 1)
	go func() {
		reader, err := store.Open(context.Background(), key1, func(context.Context, string) error {
			close(started)
			<-release
			return nil
		})
		if err == nil {
			err = reader.Close()
		}
		firstOpened <- err
	}()
	<-started
	opened := make(chan error, 1)
	go func() {
		reader, err := store.Open(context.Background(), key2, accept)
		if err == nil {
			err = reader.Close()
		}
		opened <- err
	}()
	select {
	case err := <-opened:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("cache open blocked on validation")
	}
	close(release)
	if err := <-firstOpened; err != nil {
		t.Fatal(err)
	}
}

func TestOpenCancellationPreservesEntry(t *testing.T) {
	store, err := New(t.TempDir(), 1024)
	if err != nil {
		t.Fatal(err)
	}
	key := stringsOf('8')
	writePartial(t, store, key, "valid")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = store.Open(ctx, key, func(context.Context, string) error { return context.Canceled })
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("Open error = %v, want cancellation", err)
	}
	path, _ := store.path(key)
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("cancelled validation removed valid entry: %v", err)
	}
}

func TestOpenCoordinatesReplacementAfterValidation(t *testing.T) {
	store, err := New(t.TempDir(), 1024)
	if err != nil {
		t.Fatal(err)
	}
	key := stringsOf('9')
	writePartial(t, store, key, "old")
	started := make(chan struct{})
	release := make(chan struct{})
	opened := make(chan []byte, 1)
	openErr := make(chan error, 1)
	go func() {
		reader, err := store.Open(context.Background(), key, func(context.Context, string) error {
			close(started)
			<-release
			return nil
		})
		if err != nil {
			openErr <- err
			return
		}
		body, readErr := io.ReadAll(reader)
		_ = reader.Close()
		if readErr != nil {
			openErr <- readErr
			return
		}
		opened <- body
		openErr <- nil
	}()
	<-started
	replacementDone := make(chan error, 1)
	go func() {
		p, err := store.Begin(key)
		if err == nil {
			_, err = p.Write([]byte("new"))
		}
		if err == nil {
			err = p.Commit(context.Background(), accept)
		}
		replacementDone <- err
	}()
	select {
	case err := <-replacementDone:
		t.Fatalf("replacement completed during validation: %v", err)
	case <-time.After(50 * time.Millisecond):
	}
	close(release)
	if err := <-openErr; err != nil {
		t.Fatal(err)
	}
	if body := <-opened; string(body) != "old" {
		t.Fatalf("opened replacement during validation: %q", body)
	}
	if err := <-replacementDone; err != nil {
		t.Fatal(err)
	}
}

func TestPartialPublishesOnlyAfterValidationAndRename(t *testing.T) {
	store, err := New(t.TempDir(), 1024)
	if err != nil {
		t.Fatal(err)
	}
	key := stringsOf('5')
	partial, err := store.Begin(key)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := partial.Write([]byte("preview")); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Open(context.Background(), key, accept); !errors.Is(err, ErrMiss) {
		t.Fatalf("partial open error = %v", err)
	}
	final, err := store.path(key)
	if err != nil {
		t.Fatal(err)
	}
	validated := false
	validator := ValidatorFunc(func(ctx context.Context, path string) error {
		if path != partial.Path() {
			t.Fatalf("validated %q, want partial %q", path, partial.Path())
		}
		if _, err := os.Stat(final); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("final existed before validation: %v", err)
		}
		validated = true
		return accept(ctx, path)
	})
	if err := partial.Commit(context.Background(), validator); err != nil {
		t.Fatal(err)
	}
	if !validated {
		t.Fatal("partial was not validated")
	}
	reader, err := store.Open(context.Background(), key, accept)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	if body, err := io.ReadAll(reader); err != nil || string(body) != "preview" {
		t.Fatalf("published body = %q, %v", body, err)
	}
}

func TestCleanupPartialsAndDiskLimit(t *testing.T) {
	store, err := New(t.TempDir(), 2)
	if err != nil {
		t.Fatal(err)
	}
	partial, err := store.Begin(stringsOf('3'))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := partial.Write([]byte("three")); err != nil {
		t.Fatal(err)
	}
	if err := partial.Commit(context.Background(), accept); !errors.Is(err, ErrDiskLimit) {
		t.Fatalf("Commit error = %v, want disk limit", err)
	}
	path := filepath.Join(t.TempDir(), "unused.partial")
	_ = path
	// Simulate an abandoned prior-process partial directly beneath the cache.
	orphan := filepath.Join(store.root, "previews", "aa", "bb", "orphan.partial")
	if err := os.MkdirAll(filepath.Dir(orphan), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(orphan, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := store.CleanupPartials(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(orphan); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("orphan still exists: %v", err)
	}
}

func TestBeginPermissionFailure(t *testing.T) {
	root := t.TempDir()
	store, err := New(root, 1024)
	if err != nil {
		t.Fatal(err)
	}
	previewRoot := filepath.Join(root, "previews")
	if err := os.Chmod(previewRoot, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(previewRoot, 0o750) })
	if _, err := store.Begin(stringsOf('4')); err == nil {
		t.Skip("permission checks are bypassed by this test user")
	}
}

func writePartial(t *testing.T, store *Store, key, body string) {
	t.Helper()
	p, err := store.Begin(key)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.Write([]byte(body)); err != nil {
		t.Fatal(err)
	}
	if err := p.Commit(context.Background(), accept); err != nil {
		t.Fatal(err)
	}
}

func stringsOf(c byte) string {
	return string(make([]byte, 64, 64))[:0] + repeat(c, 64)
}

func repeat(c byte, n int) string {
	b := make([]byte, n)
	for i := range b {
		b[i] = c
	}
	return string(b)
}
