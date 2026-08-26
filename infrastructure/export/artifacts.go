package export

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"sync"
	"time"
)

var ErrOutputUnavailable = errors.New("export output unavailable")

type Artifact struct {
	Path, Name, Kind string
	Expires          time.Time
}
type ArtifactStore struct {
	mu     sync.Mutex
	values map[string][]Artifact
	active map[string]int
}

func NewArtifactStore() *ArtifactStore {
	return &ArtifactStore{values: map[string][]Artifact{}, active: map[string]int{}}
}
func (s *ArtifactStore) Put(job string, values []Artifact) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.values[job] = append([]Artifact(nil), values...)
}

// Remove rolls back published artifacts after a durable job transition fails.
func (s *ArtifactStore) Remove(job string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, value := range s.values[job] {
		_ = os.Remove(value.Path)
	}
	delete(s.values, job)
}
func (s *ArtifactStore) Open(job string, position int, now time.Time) (io.ReadCloser, Artifact, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	values, ok := s.values[job]
	if !ok || position < 0 || position >= len(values) {
		return nil, Artifact{}, ErrOutputUnavailable
	}
	value := values[position]
	if value.Kind != KindDownload || !value.Expires.After(now) {
		return nil, Artifact{}, ErrOutputUnavailable
	}
	// Open first, then compare the descriptor identity with the current path.
	// This avoids validating a pathname and reopening a potentially replaced file.
	file, err := os.Open(value.Path)
	if err != nil {
		return nil, Artifact{}, ErrOutputUnavailable
	}
	fdInfo, err := file.Stat()
	if err != nil {
		_ = file.Close()
		return nil, Artifact{}, ErrOutputUnavailable
	}
	resolved, err := filepath.EvalSymlinks(value.Path)
	if err != nil {
		_ = file.Close()
		return nil, Artifact{}, ErrOutputUnavailable
	}
	base, err := filepath.EvalSymlinks(filepath.Dir(value.Path))
	if err != nil {
		_ = file.Close()
		return nil, Artifact{}, ErrOutputUnavailable
	}
	rel, relErr := filepath.Rel(base, resolved)
	pathInfo, pathErr := os.Stat(value.Path)
	if relErr != nil || pathErr != nil || !os.SameFile(fdInfo, pathInfo) || filepath.Dir(resolved) != base || rel == ".." || len(rel) >= 2 && rel[:2] == ".."+string(filepath.Separator) {
		_ = file.Close()
		return nil, Artifact{}, ErrOutputUnavailable
	}
	s.active[job]++
	return &trackedFile{File: file, done: func() { s.mu.Lock(); s.active[job]--; s.mu.Unlock() }}, value, nil
}

// Cleanup skips active streams; in-process tracking intentionally does not cover another process.
func (s *ArtifactStore) Cleanup(now time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for job, values := range s.values {
		if s.active[job] > 0 {
			continue
		}
		kept := values[:0]
		for _, v := range values {
			if v.Kind == KindArchive || v.Expires.After(now) {
				kept = append(kept, v)
			} else {
				_ = os.Remove(v.Path)
			}
		}
		if len(kept) == 0 {
			delete(s.values, job)
		} else {
			s.values[job] = kept
		}
	}
}

type trackedFile struct {
	*os.File
	done func()
}

func (f *trackedFile) Close() error { err := f.File.Close(); f.done(); return err }
