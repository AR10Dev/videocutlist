// Package adapters connects preview ports to cache and media infrastructure.
package adapters

import (
	"context"
	"errors"
	"io"
	"os"

	"videocutlist/internal/db"
	"videocutlist/internal/library/media/index"
	previewdomain "videocutlist/internal/preview"
	"videocutlist/internal/preview/cache"
	"videocutlist/internal/preview/ffmpeg"
)

type PreviewCache struct{ Store *cache.Store }

func (p PreviewCache) Open(ctx context.Context, key string, validator func(context.Context, *os.File) error) (io.ReadCloser, error) {
	return p.Store.Open(ctx, key, validator)
}
func (p PreviewCache) Begin(key string) (previewdomain.PreviewPartial, error) {
	return p.Store.Begin(key)
}

type PreviewRunner struct {
	Scanner *index.Scanner
	Media   *store.MediaStore
	FFmpeg  ffmpeg.Runner
}

func (r PreviewRunner) Start(ctx context.Context, spec previewdomain.TranscodeSpec) (*previewdomain.RunningPreview, error) {
	source, item, err := r.Scanner.Open(ctx, r.Media, spec.MediaID)
	if err != nil {
		return nil, err
	}
	closeSource := func(primary error) error {
		if closeErr := source.Close(); closeErr != nil {
			return errors.Join(primary, closeErr)
		}
		return primary
	}
	if item.ID != spec.MediaID || item.SizeBytes != spec.SizeBytes || item.MtimeNS != spec.MtimeNS {
		return nil, closeSource(index.ErrSourceChanged)
	}
	file, ok := source.(*os.File)
	if !ok {
		return nil, closeSource(errors.New("media source is not a file"))
	}
	running, err := r.FFmpeg.Start(ctx, file, spec)
	closeErr := source.Close()
	if err != nil {
		if closeErr != nil {
			return nil, errors.Join(err, closeErr)
		}
		return nil, err
	}
	if closeErr != nil {
		wait := running.Wait
		running.Wait = func() error { return errors.Join(closeErr, wait()) }
	}
	return running, nil
}
