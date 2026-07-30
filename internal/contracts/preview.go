// Package contracts contains controller-owned interfaces shared across agents.
package contracts

import (
	"context"
	"io"
	"os"
)

// PreviewSpec is already normalized; runners must not reinterpret its window.
// Source is an open, validated original. Linux runners may pass it to FFmpeg as
// an inherited descriptor so no client-controlled path enters the command.
type PreviewSpec struct {
	Source      *os.File
	MediaID     string
	SizeBytes   int64
	MtimeNS     int64
	StartMS     int64
	DurationMS  int64
	OffsetMS    int64
	Width       int
	Height      int
	FPS         int
	Audio       bool
	Encoder     string
	EncoderImpl string
}

// RunningPreview exposes bytes immediately and completion separately.
// Wait must be called exactly once; closing Stdout alone does not publish cache.
type RunningPreview struct {
	Stdout io.ReadCloser
	PID    int
	Wait   func() error
}

type PreviewRunner interface {
	Start(context.Context, PreviewSpec) (*RunningPreview, error)
}
