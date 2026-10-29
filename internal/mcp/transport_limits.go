package mcp

import (
	"net"
	"time"
)

func (t *Transport) acquireWork(credentialID string) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.shuttingDown || t.workRequests[credentialID] >= t.config.MaxConcurrentRequests {
		return false
	}
	t.workRequests[credentialID]++
	return true
}
func (t *Transport) releaseWork(credentialID string) {
	t.mu.Lock()
	t.workRequests[credentialID]--
	if t.workRequests[credentialID] <= 0 {
		delete(t.workRequests, credentialID)
	}
	t.mu.Unlock()
	t.notifyWorkChanged()
}
func (t *Transport) acquireControl(credentialID string) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.shuttingDown || t.controlRequests[credentialID] >= maxControlConcurrentRequests {
		return false
	}
	t.controlRequests[credentialID]++
	return true
}
func (t *Transport) releaseControl(credentialID string) {
	t.mu.Lock()
	t.controlRequests[credentialID]--
	if t.controlRequests[credentialID] <= 0 {
		delete(t.controlRequests, credentialID)
	}
	t.mu.Unlock()
	t.notifyWorkChanged()
}
func (t *Transport) allowPreAuthenticationRequest(clientIP net.IP) bool {
	if clientIP == nil {
		return false
	}
	key := clientIP.String()
	now := t.config.Now().UTC()
	t.mu.Lock()
	defer t.mu.Unlock()
	t.prunePreAuthenticationRates(now)
	entry, exists := t.preAuthRates[key]
	if !exists {
		if len(t.preAuthRates) >= maxPreAuthenticationRateLimitEntries {
			return false
		}
		entry = rate{window: now}
		expiresAt := now.Add(time.Minute)
		if t.nextPreAuthRatePrune.IsZero() || expiresAt.Before(t.nextPreAuthRatePrune) {
			t.nextPreAuthRatePrune = expiresAt
		}
	}
	if entry.count >= t.config.RequestsPerMinute {
		return false
	}
	entry.count++
	t.preAuthRates[key] = entry
	return true
}

func (t *Transport) prunePreAuthenticationRates(now time.Time) {
	if t.nextPreAuthRatePrune.IsZero() || now.Before(t.nextPreAuthRatePrune) {
		return
	}
	t.nextPreAuthRatePrune = time.Time{}
	for ip, existing := range t.preAuthRates {
		expiresAt := existing.window.Add(time.Minute)
		if !now.Before(expiresAt) {
			delete(t.preAuthRates, ip)
			continue
		}
		if t.nextPreAuthRatePrune.IsZero() || expiresAt.Before(t.nextPreAuthRatePrune) {
			t.nextPreAuthRatePrune = expiresAt
		}
	}
}

func (t *Transport) allowRequest(credentialID string) bool {
	now := t.config.Now().UTC()
	t.mu.Lock()
	defer t.mu.Unlock()
	for id, existing := range t.rates {
		if now.Sub(existing.window) >= time.Minute {
			delete(t.rates, id)
		}
	}
	entry := t.rates[credentialID]
	if entry.window.IsZero() || now.Sub(entry.window) >= time.Minute {
		entry = rate{window: now}
	}
	if entry.count >= t.config.RequestsPerMinute {
		return false
	}
	entry.count++
	t.rates[credentialID] = entry
	return true
}
