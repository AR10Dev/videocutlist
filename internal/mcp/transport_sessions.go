package mcp

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
	"net/http"
	"time"
)

func (t *Transport) newSession(credentialID string) (string, error) {
	bytes := make([]byte, 24)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	now := t.config.Now().UTC()
	t.pruneSessions(now)
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.shuttingDown {
		return "", errors.New("mcp transport is shutting down")
	}
	if t.sessionCountLocked(credentialID) >= t.config.MaxSessions {
		return "", errors.New("session capacity reached")
	}
	id := base64.RawURLEncoding.EncodeToString(bytes)
	t.sessions[id] = &session{credentialID: credentialID, lastUsed: now, initializing: true}
	return id, nil
}
func (t *Transport) validSession(r *http.Request, credentialID string, trackRequest bool) bool {
	values := r.Header.Values("Mcp-Session-Id")
	if len(values) != 1 || values[0] == "" || len(values[0]) > 128 {
		return false
	}
	now := t.config.Now().UTC()
	t.pruneSessions(now)
	t.mu.Lock()
	defer t.mu.Unlock()
	entry := t.sessions[values[0]]
	if entry == nil || entry.credentialID != credentialID || !entry.initialized || entry.closing {
		return false
	}
	entry.lastUsed = now
	if trackRequest {
		entry.inFlight++
	}
	return true
}
func (t *Transport) releaseSessionRequest(id string) {
	now := t.config.Now().UTC()
	t.mu.Lock()
	if entry := t.sessions[id]; entry != nil {
		entry.inFlight--
		if entry.inFlight < 0 {
			panic("negative MCP session request count")
		}
		entry.lastUsed = now
	}
	t.mu.Unlock()
	t.pruneSessions(now)
}
func (t *Transport) hasSessionCapacity(credentialID string) bool {
	t.pruneSessions(t.config.Now().UTC())
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.sessionCountLocked(credentialID) < t.config.MaxSessions
}
func (t *Transport) sessionCountLocked(credentialID string) int {
	count := 0
	for _, entry := range t.sessions {
		if entry.credentialID == credentialID {
			count++
		}
	}
	return count
}
func (t *Transport) finishInitialization(id string) {
	t.mu.Lock()
	entry := t.sessions[id]
	if entry == nil {
		t.mu.Unlock()
		return
	}
	entry.initializing = false
	entry.initialized = serverHasInitializedSession(entry.server, id)
	if entry.initialized {
		t.mu.Unlock()
		return
	}
	entry.closing = true
	t.mu.Unlock()
	closeServerSession(entry.server, id)
	t.mu.Lock()
	if t.sessions[id] == entry {
		delete(t.sessions, id)
	}
	t.mu.Unlock()
}
func (t *Transport) removeSession(id string) {
	t.mu.Lock()
	entry := t.sessions[id]
	if entry != nil {
		entry.closing = true
	}
	t.mu.Unlock()
	if entry == nil {
		return
	}
	closeServerSession(entry.server, id)
	t.mu.Lock()
	if t.sessions[id] == entry {
		delete(t.sessions, id)
	}
	t.mu.Unlock()
}
func (t *Transport) pruneSessions(now time.Time) {
	type staleSession struct {
		id    string
		entry *session
	}
	var stale []staleSession
	t.mu.Lock()
	for id, entry := range t.sessions {
		if entry.initializing || entry.inFlight != 0 || entry.closing {
			continue
		}
		expired := now.Sub(entry.lastUsed) >= t.config.SessionTTL
		missing := entry.initialized && !serverHasInitializedSession(entry.server, id)
		if expired || missing {
			entry.closing = true
			stale = append(stale, staleSession{id: id, entry: entry})
		}
	}
	t.mu.Unlock()
	for _, stale := range stale {
		closeServerSession(stale.entry.server, stale.id)
		t.mu.Lock()
		if t.sessions[stale.id] == stale.entry {
			delete(t.sessions, stale.id)
		}
		t.mu.Unlock()
	}
}
func serverHasInitializedSession(server *sdk.Server, id string) bool {
	if server == nil {
		return false
	}
	for session := range server.Sessions() {
		if session.ID() == id && session.InitializeParams() != nil {
			return true
		}
	}
	return false
}
func closeServerSession(server *sdk.Server, id string) {
	if server == nil {
		return
	}
	for session := range server.Sessions() {
		if session.ID() == id {
			_ = session.Close()
			return
		}
	}
}
