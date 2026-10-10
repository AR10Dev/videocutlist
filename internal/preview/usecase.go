package preview

import (
	"context"
	"errors"

	"videocutlist/internal/preview/cache"
)

type PreviewCatalog interface {
	Preview(context.Context, PreviewSpec) (TranscodeSpec, error)
}

type PreviewUseCase struct {
	Catalog PreviewCatalog
	Manager *PreviewManager
}

func (p PreviewUseCase) Start(ctx context.Context, request PreviewSpec) (PreviewResult, error) {
	spec, err := p.Catalog.Preview(ctx, request)
	if err != nil {
		return PreviewResult{}, err
	}
	reader, result, err := p.Manager.Preview(ctx, spec)
	if err != nil {
		return PreviewResult{}, err
	}
	return PreviewResult{Reader: reader, CacheStatus: string(result.Status), StartMS: request.StartMS, DurationMS: request.WindowMS, OffsetMS: request.OffsetMS}, nil
}

func (p PreviewUseCase) Cached(ctx context.Context, request PreviewSpec) (bool, error) {
	spec, err := p.Catalog.Preview(ctx, request)
	if err != nil {
		return false, err
	}
	return p.Manager.Cached(ctx, spec)
}

func (m *PreviewManager) Cached(ctx context.Context, spec TranscodeSpec) (bool, error) {
	reader, err := m.cache.Open(ctx, PreviewKey(spec), m.validator)
	if errors.Is(err, cache.ErrMiss) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, reader.Close()
}
