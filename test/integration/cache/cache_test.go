package cache_test

import (
	"context"
	"errors"
	"io"
	"os"
	"testing"

	cachepkg "editapp/internal/cache"
)

func TestInvalidCompleteFileIsNeverAHit(t *testing.T) {
	store, err := cachepkg.New(t.TempDir(), 1024)
	if err != nil {
		t.Fatal(err)
	}
	key := "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	partial, err := store.Begin(key)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := partial.Write([]byte("invalid")); err != nil {
		t.Fatal(err)
	}
	bad := cachepkg.ValidatorFunc(func(context.Context, string) error { return errors.New("probe failed") })
	if err := partial.Commit(context.Background(), bad); err == nil {
		t.Fatal("invalid preview was committed")
	}
	if _, err := store.Open(context.Background(), key, bad); !errors.Is(err, cachepkg.ErrMiss) {
		t.Fatalf("open error = %v", err)
	}
	_ = io.EOF
	_ = os.ErrNotExist
}
