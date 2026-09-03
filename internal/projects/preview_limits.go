package projects

import (
	"context"
	"errors"
	"sync"
	"time"
)

var (
	ErrGlobalLimit = errors.New("preview global limit reached")
)

// PreviewLimits bounds concurrent preview processes globally.
type PreviewLimits struct {
	mu     sync.Mutex
	global int
	active int
}

func NewPreviewLimits(global int) (*PreviewLimits, error) {
	if global < 1 {
		return nil, errors.New("preview limits must be positive")
	}
	return &PreviewLimits{global: global}, nil
}

// SetLimits applies limits to previews admitted after this call.
func (p *PreviewLimits) SetLimits(global int) error {
	if global < 1 {
		return errors.New("preview limits must be positive")
	}
	p.mu.Lock()
	p.global = global
	p.mu.Unlock()
	return nil
}

// AcquireProcess reserves one global FFmpeg process slot.
func (p *PreviewLimits) AcquireProcess() (func(), error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.active >= p.global {
		return nil, ErrGlobalLimit
	}
	return p.reserveProcessLocked(), nil
}

// AcquireProcessContext waits for capacity while observing cancellation.
func (p *PreviewLimits) AcquireProcessContext(ctx context.Context) (func(), error) {
	for {
		p.mu.Lock()
		if p.active < p.global {
			release := p.reserveProcessLocked()
			p.mu.Unlock()
			return release, nil
		}
		p.mu.Unlock()
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(10 * time.Millisecond):
		}
	}
}

func (p *PreviewLimits) reserveProcessLocked() func() {
	p.active++
	var once sync.Once
	return func() {
		once.Do(func() {
			p.mu.Lock()
			p.active--
			p.mu.Unlock()
		})
	}
}

func (p *PreviewLimits) Active() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.active
}
