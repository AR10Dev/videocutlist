package cache

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"

	"editapp/internal/contracts"
)

var accept = ValidatorFunc(func(_ context.Context, path string) error {
	info, err := os.Stat(path)
	if err != nil || info.Size() == 0 {
		return errors.New("invalid preview")
	}
	return nil
})

func TestKeyAndPathAreFrozen(t *testing.T) {
	spec := contracts.PreviewSpec{MediaID: "m_test", SizeBytes: 3, MtimeNS: 4, StartMS: 5, DurationMS: 6, Width: 1280, Height: 720, FPS: 30, Audio: true, Encoder: "software-h264-v1"}
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
	time.Sleep(time.Millisecond) // ensure deterministic LRU ordering on coarse filesystems.
	writePartial(t, store, key2, "two")
	if _, err := store.Open(context.Background(), key1, accept); err != nil {
		t.Fatalf("leased entry was evicted: %v", err)
	}
	if _, err := store.Open(context.Background(), key2, accept); !errors.Is(err, ErrMiss) {
		t.Fatalf("new entry error = %v, want miss after bounded eviction", err)
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
