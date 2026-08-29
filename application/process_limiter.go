package application

import "context"

// ProcessLimiter is the shared FFmpeg process budget.
type ProcessLimiter interface {
	AcquireProcess() (func(), error)
}

type contextProcessLimiter interface {
	AcquireProcessContext(context.Context) (func(), error)
}

// AcquireProcess reserves capacity, waiting only when the limiter supports cancellation-aware admission.
func AcquireProcess(ctx context.Context, limiter ProcessLimiter) (func(), error) {
	if l, ok := limiter.(contextProcessLimiter); ok {
		return l.AcquireProcessContext(ctx)
	}
	return limiter.AcquireProcess()
}
