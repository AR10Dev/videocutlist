package contextio

import (
	"context"
	"errors"
	"io"
	"strings"
	"testing"
	"time"
)

type readerFunc func([]byte) (int, error)

func (f readerFunc) Read(p []byte) (int, error) { return f(p) }

func TestReaderCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	calls := 0
	reader := NewReader(ctx, readerFunc(func(p []byte) (int, error) {
		calls++
		return copy(p, "a"), nil
	}))
	buffer := make([]byte, 1)
	if n, err := reader.Read(buffer); n != 1 || err != nil {
		t.Fatalf("read = %d, %v", n, err)
	}
	cancel()
	for range 2 {
		if n, err := reader.Read(buffer); n != 0 || !errors.Is(err, context.Canceled) {
			t.Fatalf("cancelled read = %d, %v", n, err)
		}
	}
	if calls != 1 {
		t.Fatalf("underlying reads = %d, want 1", calls)
	}
}

func TestReaderExpiredDeadline(t *testing.T) {
	ctx, cancel := context.WithDeadline(t.Context(), time.Now().Add(-time.Second))
	defer cancel()
	reader := NewReader(ctx, readerFunc(func([]byte) (int, error) {
		t.Fatal("underlying reader called after deadline")
		return 0, nil
	}))
	if n, err := reader.Read(make([]byte, 1)); n != 0 || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expired read = %d, %v", n, err)
	}
}

func TestReaderPreservesUnderlyingResult(t *testing.T) {
	for _, err := range []error{io.EOF, errors.New("read failed")} {
		reader := NewReader(t.Context(), readerFunc(func(p []byte) (int, error) {
			return copy(p, "ab"), err
		}))
		buffer := make([]byte, 4)
		n, gotErr := reader.Read(buffer)
		if n != 2 || gotErr != err || string(buffer[:n]) != "ab" {
			t.Fatalf("read = %q, %d, %v", buffer, n, gotErr)
		}
	}
}

func TestCopyCannotBypassCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	// strings.Reader implements WriterTo; the wrapper must hide that fast path.
	reader := NewReader(ctx, strings.NewReader("must not copy"))
	var destination strings.Builder
	n, err := io.Copy(&destination, reader)
	if n != 0 || !errors.Is(err, context.Canceled) || destination.Len() != 0 {
		t.Fatalf("copy = %d, %v, %q", n, err, destination.String())
	}
}
