package preview

import (
	"context"
	"errors"
	"io"
)

var ErrNoAudio = errors.New("no_audio")

type PreviewSpec struct {
	MediaID                                 string
	DurationMS, StartMS, WindowMS, OffsetMS int64
	Mute                                    bool
}

type PreviewResult struct {
	Reader                        io.ReadCloser
	CacheStatus                   string
	StartMS, DurationMS, OffsetMS int64
}

type AssetSpec struct {
	MediaID    string
	StartMS    int64
	DurationMS int64
	Count      int
	Width      int
	Samples    int
}

type AssetResult struct {
	Reader      io.ReadCloser
	ContentType string
	CacheStatus string
	StartMS     int64
	DurationMS  int64
	Peaks       []float64
}

type PreviewService interface {
	Start(context.Context, PreviewSpec) (PreviewResult, error)
	Cached(context.Context, PreviewSpec) (bool, error)
}

type AssetService interface {
	ValidateSource(context.Context, string) error
	Thumbnails(context.Context, AssetSpec) (AssetResult, error)
	Waveform(context.Context, AssetSpec) (AssetResult, error)
}

// NormalizePreview is the one frozen preview-window implementation used by all transports.
func NormalizePreview(mediaID string, durationMS, centerMS int64, mute bool, cfg WindowConfig) (PreviewSpec, error) {
	window, err := Normalize(centerMS, durationMS, cfg)
	if err != nil {
		return PreviewSpec{}, err
	}
	return PreviewSpec{MediaID: mediaID, DurationMS: durationMS, StartMS: window.StartMS, WindowMS: window.DurationMS, OffsetMS: window.OffsetMS, Mute: mute}, nil
}
