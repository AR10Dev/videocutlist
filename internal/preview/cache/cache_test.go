package cache

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"videocutlist/internal/projects/model"
)

var accept = func(_ context.Context, file *os.File) error {
	info, err := file.Stat()
	if err != nil || info.Size() == 0 {
		return errors.New("invalid preview")
	}
	return nil
}

func TestCommitDoesNotPublishWhenCancelledAfterValidation(t *testing.T) {
	store, err := New(t.TempDir(), 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	key := "9fd5a59c541b3e2faab0b0c8a72daf70b258cfbfc6adfe6b2ae65024fece9f5f"
	partial, err := store.Begin(key)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := partial.Write([]byte("complete")); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	validator := func(context.Context, *os.File) error {
		cancel()
		return nil
	}
	if err := partial.Commit(ctx, validator); !errors.Is(err, context.Canceled) {
		t.Fatalf("commit error = %v, want cancellation", err)
	}
	if hit, err := store.Open(context.Background(), key, accept); !errors.Is(err, ErrMiss) {
		if hit != nil {
			_ = hit.Close()
		}
		t.Fatalf("cancelled cache = %v, want miss", err)
	}
}

func TestCommitRejectsReplacedPartialAfterValidation(t *testing.T) {
	for _, test := range []struct {
		name    string
		symlink bool
	}{{"regular", false}, {"symlink", true}} {
		t.Run(test.name, func(t *testing.T) {
			store, err := New(t.TempDir(), 1024)
			if err != nil {
				t.Fatal(err)
			}
			key := stringsOf('f')
			partial, err := store.Begin(key)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := partial.Write([]byte("validated")); err != nil {
				t.Fatal(err)
			}
			external := filepath.Join(t.TempDir(), "unvalidated.mp4")
			if err := os.WriteFile(external, []byte("unvalidated"), 0o600); err != nil {
				t.Fatal(err)
			}
			err = partial.Commit(t.Context(), func(_ context.Context, file *os.File) error {
				if err := os.Rename(file.Name(), file.Name()+".retained"); err != nil {
					return err
				}
				if test.symlink {
					return os.Symlink(external, file.Name())
				}
				return os.WriteFile(file.Name(), []byte("unvalidated"), 0o600)
			})
			if err == nil {
				t.Fatal("replacement published without descriptor validation")
			}
			final, err := store.path(key)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := os.Lstat(final); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("unvalidated final exists: %v", err)
			}
			if body, err := os.ReadFile(partial.Path()); err != nil || string(body) != "unvalidated" {
				t.Fatalf("replacement path was removed or changed: %q, %v", body, err)
			}
			if body, err := os.ReadFile(external); err != nil || string(body) != "unvalidated" {
				t.Fatalf("external content changed: %q, %v", body, err)
			}
		})
	}
}

func TestPreviewKeyAndPathAreFrozen(t *testing.T) {
	spec := model.PreviewSpec{MediaID: "m_test", SizeBytes: 3, MtimeNS: 4, StartMS: 5, DurationMS: 6, Width: 1280, Height: 720, FPS: 30, Audio: true, Encoder: "software-h264-v1"}
	key := model.PreviewKey(spec)
	if got, want := key, "9fd5a59c541b3e2faab0b0c8a72daf70b258cfbfc6adfe6b2ae65024fece9f5f"; got != want {
		t.Fatalf("key = %s, want %s", got, want)
	}
	path, err := RelativePath(key)
	if err != nil || path != filepath.Join("previews", "9f", "d5", key+".mp4") {
		t.Fatalf("path = %q, %v", path, err)
	}
}

func TestConcurrentCommitsKeepOneCompleteWinner(t *testing.T) {
	store, err := New(t.TempDir(), 1024)
	if err != nil {
		t.Fatal(err)
	}
	key := stringsOf('a')
	first, err := store.Begin(key)
	if err != nil {
		t.Fatal(err)
	}
	second, err := store.Begin(key)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = first.Write([]byte("first"))
	_, _ = second.Write([]byte("second"))
	errs := make(chan error, 2)
	go func() { errs <- first.Commit(context.Background(), accept) }()
	go func() { errs <- second.Commit(context.Background(), accept) }()
	if err := <-errs; err != nil {
		t.Fatal(err)
	}
	if err := <-errs; err != nil {
		t.Fatal(err)
	}
	reader, err := store.Open(context.Background(), key, accept)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := reader.Close(); err != nil {
			t.Error(err)
		}
	})
	body, _ := io.ReadAll(reader)
	if string(body) != "first" && string(body) != "second" {
		t.Fatalf("winner = %q", body)
	}
	matches, err := filepath.Glob(filepath.Join(store.root, "previews", "aa", "aa", "*.partial"))
	if err != nil || len(matches) != 0 {
		t.Fatalf("partial files = %v, %v", matches, err)
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
	t.Cleanup(func() {
		if err := reader.Close(); err != nil {
			t.Error(err)
		}
	})
	if b, _ := io.ReadAll(reader); string(b) != "one" {
		t.Fatalf("got %q", b)
	}
	writePartial(t, store, key2, "two")
	leasedReader, err := store.Open(context.Background(), key1, accept)
	if err != nil {
		t.Fatalf("leased entry was evicted: %v", err)
	}
	if err := leasedReader.Close(); err != nil {
		t.Fatal(err)
	}
	newReader, err := store.Open(context.Background(), key2, accept)
	if newReader != nil {
		if err := newReader.Close(); err != nil {
			t.Error(err)
		}
		t.Fatal("new entry unexpectedly opened")
	}
	if !errors.Is(err, ErrMiss) {
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
	firstDone := make(chan struct{})
	secondDone := make(chan struct{})
	secondLaunched := false
	var releaseOnce sync.Once
	defer func() {
		releaseOnce.Do(func() { close(release) })
		select {
		case <-firstDone:
		case <-time.After(time.Second):
			t.Error("first cache open did not exit after release")
		}
		if secondLaunched {
			select {
			case <-secondDone:
			case <-time.After(time.Second):
				t.Error("cross-key cache open did not exit")
			}
		}
	}()
	go func() {
		defer close(firstDone)
		reader, err := store.Open(context.Background(), key1, func(context.Context, *os.File) error {
			close(started)
			<-release
			return nil
		})
		if err == nil {
			err = reader.Close()
		}
		firstOpened <- err
	}()
	select {
	case <-started:
	case <-firstDone:
		t.Fatal("first cache open exited before validation")
	case <-time.After(time.Second):
		t.Fatal("first cache open did not enter validation")
	}
	opened := make(chan error, 1)
	secondLaunched = true
	go func() {
		defer close(secondDone)
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
	releaseOnce.Do(func() { close(release) })
	select {
	case err := <-firstOpened:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("first cache open did not finish after validation release")
	}
}

func TestOpenInvalidEntryCanBeRegenerated(t *testing.T) {
	for _, body := range []string{"", "corrupt"} {
		t.Run(body, func(t *testing.T) {
			store, err := New(t.TempDir(), 1024)
			if err != nil {
				t.Fatal(err)
			}
			key := stringsOf('d')
			path, err := store.path(key)
			if err != nil {
				t.Fatal(err)
			}
			if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
				t.Fatal(err)
			}
			validate := func(_ context.Context, file *os.File) error {
				content, err := io.ReadAll(file)
				if err != nil {
					return err
				}
				if string(content) != "regenerated" {
					return errors.New("invalid preview")
				}
				return nil
			}
			if reader, err := store.Open(t.Context(), key, validate); !errors.Is(err, ErrMiss) {
				if reader != nil {
					_ = reader.Close()
				}
				t.Fatalf("invalid entry error = %v, want miss", err)
			}
			writePartial(t, store, key, "regenerated")
			reader, err := store.Open(t.Context(), key, validate)
			if err != nil {
				t.Fatalf("regenerated entry error = %v, want cache hit", err)
			}
			defer func() { _ = reader.Close() }()
			content, err := io.ReadAll(reader)
			if err != nil || string(content) != "regenerated" {
				t.Fatalf("regenerated preview = %q, %v", content, err)
			}
		})
	}
}

func TestOpenRejectedEntryPreservesReplacement(t *testing.T) {
	for _, test := range []struct {
		name    string
		symlink bool
	}{{"regular", false}, {"symlink", true}} {
		t.Run(test.name, func(t *testing.T) {
			store, err := New(t.TempDir(), 1024)
			if err != nil {
				t.Fatal(err)
			}
			key := stringsOf('d')
			writePartial(t, store, key, "corrupt")
			path, err := store.path(key)
			if err != nil {
				t.Fatal(err)
			}
			replacement := filepath.Join(t.TempDir(), "replacement.mp4")
			if err := os.WriteFile(replacement, []byte("replacement"), 0o600); err != nil {
				t.Fatal(err)
			}
			reader, err := store.Open(t.Context(), key, func(_ context.Context, file *os.File) error {
				if err := os.Rename(file.Name(), file.Name()+".rejected"); err != nil {
					t.Fatal(err)
				}
				var replacementErr error
				if test.symlink {
					replacementErr = os.Symlink(replacement, path)
				} else {
					replacementErr = os.Rename(replacement, path)
				}
				if replacementErr != nil {
					t.Fatal(replacementErr)
				}
				return errors.New("invalid preview")
			})
			if reader != nil {
				_ = reader.Close()
				t.Fatal("rejected preview was leased")
			}
			if !errors.Is(err, ErrMiss) {
				t.Fatalf("rejected entry error = %v, want miss", err)
			}
			if content, err := os.ReadFile(path); err != nil || string(content) != "replacement" {
				t.Fatalf("replacement changed or removed: %q, %v", content, err)
			}
			if !test.symlink && len(store.open) != 0 {
				t.Fatalf("rejected regular entry retained lease: %v", store.open)
			}
		})
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
	_, err = store.Open(ctx, key, func(context.Context, *os.File) error { return context.Canceled })
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("Open error = %v, want cancellation", err)
	}
	path, _ := store.path(key)
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("cancelled validation removed valid entry: %v", err)
	}
}

func TestOpenRejectsSymlinkBeforeValidation(t *testing.T) {
	store, err := New(t.TempDir(), 1024)
	if err != nil {
		t.Fatal(err)
	}
	key := stringsOf('a')
	path, err := store.path(key)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		t.Fatal(err)
	}
	external := filepath.Join(t.TempDir(), "external.mp4")
	if err := os.WriteFile(external, []byte("external"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(external, path); err != nil {
		t.Fatal(err)
	}
	validated := false
	reader, err := store.Open(context.Background(), key, func(context.Context, *os.File) error {
		validated = true
		return nil
	})
	if reader != nil {
		_ = reader.Close()
		t.Fatal("symlink was leased")
	}
	if !errors.Is(err, ErrMiss) || validated {
		t.Fatalf("symlink error = %v, validated = %v; want miss before validation", err, validated)
	}
	if info, err := os.Lstat(path); err != nil || info.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("symlink replaced or removed: %v, %v", info, err)
	}
	if body, err := os.ReadFile(external); err != nil || string(body) != "external" {
		t.Fatalf("external file = %q, %v", body, err)
	}
}

func TestOpenRewindsValidatedDescriptor(t *testing.T) {
	store, err := New(t.TempDir(), 1024)
	if err != nil {
		t.Fatal(err)
	}
	key := stringsOf('e')
	writePartial(t, store, key, "complete preview")
	reader, err := store.Open(t.Context(), key, func(_ context.Context, file *os.File) error {
		body, err := io.ReadAll(file)
		if err != nil || string(body) != "complete preview" {
			t.Fatalf("validator read = %q, %v", body, err)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := reader.Close(); err != nil {
			t.Error(err)
		}
	})
	body, err := io.ReadAll(reader)
	if err != nil || string(body) != "complete preview" {
		t.Fatalf("leased preview = %q, %v; want complete content after validation", body, err)
	}
}

func TestOpenMissesWhenValidatorSwapsEntryForExternalSymlink(t *testing.T) {
	store, err := New(t.TempDir(), 1024)
	if err != nil {
		t.Fatal(err)
	}
	key := stringsOf('b')
	writePartial(t, store, key, "original")
	path, err := store.path(key)
	if err != nil {
		t.Fatal(err)
	}
	external := filepath.Join(t.TempDir(), "external.mp4")
	if err := os.WriteFile(external, []byte("external"), 0o600); err != nil {
		t.Fatal(err)
	}
	original := path + ".original"
	reader, err := store.Open(context.Background(), key, func(ctx context.Context, file *os.File) error {
		if err := accept(ctx, file); err != nil {
			return err
		}
		if err := os.Rename(file.Name(), original); err != nil {
			return err
		}
		if err := os.Symlink(external, file.Name()); err != nil {
			return err
		}
		body, err := io.ReadAll(file)
		if err != nil || string(body) != "original" {
			t.Fatalf("validated descriptor = %q, %v; want original", body, err)
		}
		return nil
	})
	if reader != nil {
		_ = reader.Close()
		t.Fatal("replacement was leased")
	}
	if !errors.Is(err, ErrMiss) {
		t.Fatalf("replacement error = %v, want miss", err)
	}
	if info, err := os.Lstat(path); err != nil || info.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("replacement symlink removed: %v, %v", info, err)
	}
	if body, err := os.ReadFile(external); err != nil || string(body) != "external" {
		t.Fatalf("external file = %q, %v", body, err)
	}
	if len(store.open) != 0 {
		t.Fatalf("miss retained lease: %v", store.open)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(original, path); err != nil {
		t.Fatal(err)
	}
	reader, err = store.Open(context.Background(), key, accept)
	if err != nil {
		t.Fatal(err)
	}
	if body, err := io.ReadAll(reader); err != nil || string(body) != "original" {
		t.Fatalf("restored entry = %q, %v", body, err)
	}
	if store.open[path] != 1 {
		t.Fatalf("hit lease count = %d, want 1", store.open[path])
	}
	if err := reader.Close(); err != nil {
		t.Fatal(err)
	}
	if len(store.open) != 0 {
		t.Fatalf("closed entry retained lease: %v", store.open)
	}
}

func TestOpenMissesWhenValidatorSwapsRegularEntry(t *testing.T) {
	store, err := New(t.TempDir(), 1024)
	if err != nil {
		t.Fatal(err)
	}
	key := stringsOf('c')
	writePartial(t, store, key, "original")
	path, err := store.path(key)
	if err != nil {
		t.Fatal(err)
	}
	original := path + ".original"
	reader, err := store.Open(context.Background(), key, func(ctx context.Context, file *os.File) error {
		if err := accept(ctx, file); err != nil {
			return err
		}
		if err := os.Rename(file.Name(), original); err != nil {
			return err
		}
		return os.WriteFile(file.Name(), []byte("replaced"), 0o600)
	})
	if reader != nil {
		_ = reader.Close()
		t.Fatal("unvalidated replacement was leased")
	}
	if !errors.Is(err, ErrMiss) {
		t.Fatalf("regular replacement error = %v, want miss", err)
	}
	if body, err := os.ReadFile(path); err != nil || string(body) != "replaced" {
		t.Fatalf("replacement removed: %q, %v", body, err)
	}
	if len(store.open) != 0 {
		t.Fatalf("miss retained lease: %v", store.open)
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
	var releaseOnce sync.Once
	openDone := make(chan struct{})
	replacementStarted := make(chan struct{})
	replacementDone := make(chan struct{})
	replacementLaunched := false
	var opened []byte
	var openErr error
	var replacementErr error
	defer func() {
		releaseOnce.Do(func() { close(release) })
		select {
		case <-openDone:
		case <-time.After(time.Second):
			t.Error("cache open did not exit after validation release")
		}
		if replacementLaunched {
			select {
			case <-replacementDone:
			case <-time.After(time.Second):
				t.Error("replacement commit did not exit")
			}
		}
	}()
	go func() {
		defer close(openDone)
		reader, err := store.Open(t.Context(), key, func(context.Context, *os.File) error {
			close(started)
			<-release
			return nil
		})
		if err != nil {
			openErr = err
			return
		}
		opened, openErr = io.ReadAll(reader)
		if err := reader.Close(); openErr == nil {
			openErr = err
		}
	}()
	select {
	case <-started:
	case <-openDone:
		t.Fatal("cache open exited before validation")
	case <-time.After(time.Second):
		t.Fatal("cache open did not enter validation")
	}
	replacementLaunched = true
	go func() {
		defer close(replacementDone)
		close(replacementStarted)
		partial, err := store.Begin(key)
		if err == nil {
			_, err = partial.Write([]byte("new"))
		}
		if err == nil {
			err = partial.Commit(t.Context(), accept)
		}
		replacementErr = err
	}()
	<-replacementStarted
	waitForBlockedMutex(t, "(*Partial).Commit", 50*time.Millisecond)
	select {
	case <-replacementDone:
		t.Fatalf("replacement completed while Open held the path lock: %v", replacementErr)
	default:
	}
	releaseOnce.Do(func() { close(release) })
	select {
	case <-openDone:
	case <-time.After(time.Second):
		t.Fatal("cache open did not finish after validation release")
	}
	if openErr != nil {
		t.Fatal(openErr)
	}
	if string(opened) != "old" {
		t.Fatalf("opened replacement during validation: %q", opened)
	}
	select {
	case <-replacementDone:
	case <-time.After(time.Second):
		t.Fatal("replacement did not finish after Open released the path lock")
	}
	if replacementErr != nil {
		t.Fatal(replacementErr)
	}
	path, err := store.path(key)
	if err != nil {
		t.Fatal(err)
	}
	if body, err := os.ReadFile(path); err != nil || string(body) != "old" {
		t.Fatalf("existing preview changed during replacement attempt: %q, %v", body, err)
	}
}

func waitForBlockedMutex(t *testing.T, function string, timeout time.Duration) {
	t.Helper()
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	for {
		stacks := make([]byte, 1<<20)
		n := runtime.Stack(stacks, true)
		blocked := false
		for _, stack := range strings.Split(string(stacks[:n]), "goroutine ") {
			if strings.Contains(stack, "[sync.Mutex.Lock]") && strings.Contains(stack, function) {
				blocked = true
				break
			}
		}
		if blocked {
			return
		}
		select {
		case <-deadline.C:
			t.Fatalf("goroutine did not block at %s; stack snapshot:\n%s", function, stacks[:n])
		default:
			runtime.Gosched()
		}
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
	validator := func(ctx context.Context, file *os.File) error {
		if file.Name() != partial.Path() {
			t.Fatalf("validated %q, want partial %q", file.Name(), partial.Path())
		}
		if _, err := os.Stat(final); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("final existed before validation: %v", err)
		}
		validated = true
		return accept(ctx, file)
	}
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
	t.Cleanup(func() {
		if err := reader.Close(); err != nil {
			t.Error(err)
		}
	})
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
	return strings.Repeat(string(c), 64)
}
