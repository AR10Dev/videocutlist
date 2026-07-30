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

// Preview counts processes, rather than subscribers. Identical requests share
// one process and therefore one permit.
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

// Acquire reserves a process slot. The returned release function is idempotent.
func (p *Preview) Acquire(user string) (func(), error) {
	if user == "" {
		return nil, errors.New("preview user is required")
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.active >= p.global {
		return nil, ErrGlobalLimit
	}
	if p.users[user] >= p.perUser {
		return nil, ErrUserLimit
	}
	p.active++
	p.users[user]++
	var once sync.Once
	return func() {
		once.Do(func() {
			p.mu.Lock()
			defer p.mu.Unlock()
			p.active--
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
