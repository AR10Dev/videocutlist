// Package contextio provides cancellation-aware I/O.
package contextio

import (
	"context"
	"io"
)

// NewReader checks cancellation before each read; it cannot interrupt a read in progress.
func NewReader(ctx context.Context, reader io.Reader) io.Reader {
	return contextReader{ctx: ctx, reader: reader}
}

type contextReader struct {
	ctx    context.Context
	reader io.Reader
}

func (r contextReader) Read(p []byte) (int, error) {
	select {
	case <-r.ctx.Done():
		return 0, r.ctx.Err()
	default:
		return r.reader.Read(p)
	}
}
