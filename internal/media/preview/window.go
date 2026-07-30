// Package preview normalizes timeline selections into cacheable preview windows.
package preview

import "fmt"

const (
	DefaultBeforeMS = int64(2_000)
	DefaultAfterMS  = int64(6_000)
	DefaultMaxMS    = int64(15_000)
	DefaultGridMS   = int64(500)
)

// WindowConfig controls preview geometry in integer milliseconds.
type WindowConfig struct {
	BeforeMS int64
	AfterMS  int64
	MaxMS    int64
	GridMS   int64
}

// DefaultWindowConfig is the frozen software preview default.
func DefaultWindowConfig() WindowConfig {
	return WindowConfig{BeforeMS: DefaultBeforeMS, AfterMS: DefaultAfterMS, MaxMS: DefaultMaxMS, GridMS: DefaultGridMS}
}

// Window is the normalized source range and exact selected offset within it.
type Window struct {
	StartMS    int64
	DurationMS int64
	OffsetMS   int64
}

// Normalize clamps the selection, grids its cache center, and shifts at media
// boundaries without moving the selected timestamp outside the returned range.
func Normalize(centerMS, mediaDurationMS int64, cfg WindowConfig) (Window, error) {
	if mediaDurationMS < 0 {
		return Window{}, fmt.Errorf("media duration must be non-negative")
	}
	if cfg.BeforeMS < 0 || cfg.AfterMS < 0 || cfg.MaxMS < 1 || cfg.GridMS < 1 || cfg.BeforeMS+cfg.AfterMS > cfg.MaxMS {
		return Window{}, fmt.Errorf("invalid preview window configuration")
	}
	if mediaDurationMS == 0 {
		return Window{}, fmt.Errorf("media duration must be positive")
	}
	if centerMS < 0 {
		centerMS = 0
	}
	if centerMS > mediaDurationMS {
		centerMS = mediaDurationMS
	}
	gridCenter := (centerMS / cfg.GridMS) * cfg.GridMS
	if gridCenter > mediaDurationMS {
		gridCenter = mediaDurationMS
	}
	duration := cfg.BeforeMS + cfg.AfterMS
	if duration > mediaDurationMS {
		duration = mediaDurationMS
	}
	start := gridCenter - cfg.BeforeMS
	if start < 0 {
		start = 0
	}
	if end := start + duration; end > mediaDurationMS {
		start = mediaDurationMS - duration
	}
	// The exact click is retained even when its cache bucket starts earlier.
	offset := centerMS - start
	if offset < 0 {
		// This only happens if a far-away bucket was shifted at the start edge.
		start = centerMS
		offset = 0
	}
	if offset > duration {
		start = centerMS - duration
		offset = duration
	}
	return Window{StartMS: start, DurationMS: duration, OffsetMS: offset}, nil
}
