// Package processio bounds captured subprocess output.
package processio

import (
	"bytes"
	"sync"
)

// LimitedBuffer rejects an entire write that would exceed the limit.
// Access it only after the subprocess has finished writing.
type LimitedBuffer struct {
	buffer   bytes.Buffer
	limit    int
	overflow error
	err      error
}

func NewLimitedBuffer(limit int, overflow error) *LimitedBuffer {
	if overflow == nil {
		panic("processio: overflow error is required")
	}
	return &LimitedBuffer{limit: limit, overflow: overflow}
}

func (b *LimitedBuffer) Write(p []byte) (int, error) {
	if b.err != nil {
		return 0, b.err
	}
	if len(p) > b.limit-b.buffer.Len() {
		b.err = b.overflow
		return 0, b.err
	}
	return b.buffer.Write(p)
}

func (b *LimitedBuffer) Err() error     { return b.err }
func (b *LimitedBuffer) Bytes() []byte  { return b.buffer.Bytes() }
func (b *LimitedBuffer) String() string { return b.buffer.String() }

// TruncatedBuffer retains a prefix while draining all remaining output.
// Reads and writes may run concurrently.
type TruncatedBuffer struct {
	mu     sync.Mutex
	buffer bytes.Buffer
	limit  int
}

func NewTruncatedBuffer(limit int) *TruncatedBuffer {
	return &TruncatedBuffer{limit: limit}
}

func (b *TruncatedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if remaining := b.limit - b.buffer.Len(); remaining > 0 {
		_, _ = b.buffer.Write(p[:min(len(p), remaining)])
	}
	return len(p), nil
}

func (b *TruncatedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buffer.String()
}

func (b *TruncatedBuffer) Bytes() []byte {
	b.mu.Lock()
	defer b.mu.Unlock()
	return bytes.Clone(b.buffer.Bytes())
}
