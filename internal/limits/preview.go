// Package limits bounds active preview processes.
package limits

import (
	"errors"
	"sync"
)

var (
	ErrGlobalLimit = errors.New("preview global limit reached")
	ErrUserLimit   = errors.New("preview per-user limit reached")
)

// Preview keeps the two different resources separate: processes consume global
// capacity while each foreground subscription consumes its user's capacity.
type Preview struct {
	mu      sync.Mutex
	global  int
	perUser int
	active  int
	users   map[string]int
}

func NewPreview(global, perUser int) (*Preview, error) {
	if global < 1 || perUser < 1 {
		return nil, errors.New("preview limits must be positive")
	}
	return &Preview{global: global, perUser: perUser, users: make(map[string]int)}, nil
}

// AcquireProcess reserves one global FFmpeg process slot.
func (p *Preview) AcquireProcess() (func(), error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.active >= p.global {
		return nil, ErrGlobalLimit
	}
	p.active++
	var once sync.Once
	return func() {
		once.Do(func() {
			p.mu.Lock()
			p.active--
			p.mu.Unlock()
		})
	}, nil
}

// AcquireUser reserves one active foreground subscription for user.
func (p *Preview) AcquireUser(user string) (func(), error) {
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

func (p *Preview) Active() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.active
}
