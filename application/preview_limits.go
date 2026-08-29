package application

import (
	"context"
	"errors"
	"sync"
	"time"
)

var (
	ErrGlobalLimit = errors.New("preview global limit reached")
	ErrUserLimit   = errors.New("preview per-user limit reached")
)

// Preview keeps the two different resources separate: processes consume global
// capacity while each foreground subscription consumes its user's capacity.
type PreviewLimits struct {
	mu      sync.Mutex
	global  int
	perUser int
	active  int
	users   map[string]int
}

func NewPreviewLimits(global, perUser int) (*PreviewLimits, error) {
	if global < 1 || perUser < 1 {
		return nil, errors.New("preview limits must be positive")
	}
	return &PreviewLimits{global: global, perUser: perUser, users: make(map[string]int)}, nil
}

// SetLimits applies limits to previews admitted after this call.
func (p *PreviewLimits) SetLimits(global, perUser int) error {
	if global < 1 || perUser < 1 {
		return errors.New("preview limits must be positive")
	}
	p.mu.Lock()
	p.global, p.perUser = global, perUser
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

// AcquireUser reserves one active foreground subscription for user.
func (p *PreviewLimits) AcquireUser(user string) (func(), error) {
	if user == "" {
		return nil, errors.New("preview user is required")
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.users[user] >= p.perUser {
		return nil, ErrUserLimit
	}
	p.users[user]++
	var once sync.Once
	return func() {
		once.Do(func() {
			p.mu.Lock()
			defer p.mu.Unlock()
			if p.users[user] == 1 {
				delete(p.users, user)
			} else {
				p.users[user]--
			}
		})
	}, nil
}

func (p *PreviewLimits) Active() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.active
}
