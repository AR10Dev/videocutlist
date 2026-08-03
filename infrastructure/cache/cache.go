// Package cache stores only complete, validated preview files.
package cache

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"videocutlist/domain"
)

var (
	ErrMiss      = domain.ErrCacheMiss
	ErrDiskLimit = errors.New("preview cache disk limit exceeded")
)

// Validator is normally backed by FFprobe. It is deliberately supplied by the
// preview pipeline so cache ownership does not duplicate subprocess code.
type Validator = func(context.Context, string) error
type ValidatorFunc = Validator

type Store struct {
	root string
	max  int64

	mu      sync.Mutex
	open    map[string]int
	partial map[string]struct{}
}

func New(root string, maxBytes int64) (*Store, error) {
	if root == "" || maxBytes < 1 {
		return nil, errors.New("cache root and positive byte limit are required")
	}
	if err := os.MkdirAll(filepath.Join(root, "previews"), 0o750); err != nil {
		return nil, fmt.Errorf("create cache directory: %w", err)
	}
	return &Store{root: root, max: maxBytes, open: make(map[string]int), partial: make(map[string]struct{})}, nil
}

// Key is the frozen v1 compact JSON identity. Do not add implementation
// details: the runtime contract intentionally keys only the encoder profile.
func Key(spec domain.PreviewSpec) string { return domain.PreviewKey(spec) }

func RelativePath(key string) (string, error) {
	if len(key) != 64 || strings.ToLower(key) != key {
		return "", errors.New("invalid cache key")
	}
	if _, err := hex.DecodeString(key); err != nil {
		return "", errors.New("invalid cache key")
	}
	return filepath.Join("previews", key[:2], key[2:4], key+".mp4"), nil
}

func (s *Store) path(key string) (string, error) {
	rel, err := RelativePath(key)
	if err != nil {
		return "", err
	}
	return filepath.Join(s.root, rel), nil
}

// Open returns a leased descriptor; an eviction will not remove a leased file.
func (s *Store) Open(ctx context.Context, key string, validator Validator) (io.ReadCloser, error) {
	if validator == nil {
		return nil, errors.New("cache validator is required")
	}
	path, err := s.path(key)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	info, err := os.Stat(path)
	if errors.Is(err, fs.ErrNotExist) || err == nil && (!info.Mode().IsRegular() || info.Size() == 0) {
		if err == nil {
			_ = os.Remove(path)
		}
		return nil, ErrMiss
	}
	if err != nil {
		return nil, err
	}
	if err := validator(ctx, path); err != nil {
		_ = os.Remove(path)
		return nil, ErrMiss
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	if err := os.Chtimes(path, time.Now(), time.Now()); err != nil {
		_ = f.Close()
		return nil, fmt.Errorf("update cache access: %w", err)
	}
	s.open[path]++
	return &leasedFile{File: f, done: func() { s.release(path) }}, nil
}

func (s *Store) release(path string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.open[path] == 1 {
		delete(s.open, path)
	} else {
		s.open[path]--
	}
}

type leasedFile struct {
	*os.File
	once sync.Once
	done func()
}

func (f *leasedFile) Close() error {
	err := f.File.Close()
	f.once.Do(f.done)
	return err
}

type Partial struct {
	store *Store
	key   string
	path  string
	file  *os.File
	once  sync.Once
}

func (s *Store) Begin(key string) (*Partial, error) {
	final, err := s.path(key)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(final), 0o750); err != nil {
		return nil, err
	}
	f, err := os.CreateTemp(filepath.Dir(final), key+"-*.partial")
	if err != nil {
		return nil, err
	}
	p := &Partial{store: s, key: key, path: f.Name(), file: f}
	s.mu.Lock()
	s.partial[p.path] = struct{}{}
	s.mu.Unlock()
	return p, nil
}

func (p *Partial) Write(b []byte) (int, error) { return p.file.Write(b) }
func (p *Partial) Path() string                { return p.path }

func (p *Partial) Discard() error {
	var err error
	p.once.Do(func() {
		err = p.file.Close()
		if removeErr := os.Remove(p.path); err == nil && removeErr != nil && !errors.Is(removeErr, fs.ErrNotExist) {
			err = removeErr
		}
		p.store.mu.Lock()
		delete(p.store.partial, p.path)
		p.store.mu.Unlock()
	})
	return err
}

// Commit validates before its atomic rename. A full cache never returns a
// success that exceeds its configured bound; the just-created entry is removed.
func (p *Partial) Commit(ctx context.Context, validator Validator) error {
	if validator == nil {
		return errors.New("cache validator is required")
	}
	var result error
	p.once.Do(func() {
		if err := p.file.Sync(); err != nil {
			result = err
			_ = p.file.Close()
			_ = os.Remove(p.path)
			return
		}
		if err := p.file.Close(); err != nil {
			result = err
			_ = os.Remove(p.path)
			return
		}
		if err := validator(ctx, p.path); err != nil {
			result = fmt.Errorf("validate preview cache: %w", err)
			_ = os.Remove(p.path)
			return
		}
		final, err := p.store.path(p.key)
		if err != nil {
			result = err
			_ = os.Remove(p.path)
			return
		}
		p.store.mu.Lock()
		defer p.store.mu.Unlock()
		if err := os.Rename(p.path, final); err != nil {
			result = err
			return
		}
		if info, err := os.Stat(final); err != nil || info.Size() > p.store.max {
			_ = os.Remove(final)
			if err != nil {
				result = err
			} else {
				result = ErrDiskLimit
			}
			return
		}
		if err := p.store.evictLocked(); err != nil {
			_ = os.Remove(final)
			result = err
		}
	})
	p.store.mu.Lock()
	delete(p.store.partial, p.path)
	p.store.mu.Unlock()
	return result
}

// CleanupPartials removes incomplete files left by a prior process. Active
// partial files in this process are protected by the store lock.
func (s *Store) CleanupPartials() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return filepath.WalkDir(filepath.Join(s.root, "previews"), func(path string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() || !strings.HasSuffix(entry.Name(), ".partial") {
			return err
		}
		if _, active := s.partial[path]; active {
			return nil
		}
		return os.Remove(path)
	})
}

type cacheFile struct {
	path string
	info fs.FileInfo
}

func (s *Store) evictLocked() error {
	var files []cacheFile
	var total int64
	err := filepath.WalkDir(filepath.Join(s.root, "previews"), func(path string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() || !strings.HasSuffix(entry.Name(), ".mp4") {
			return err
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		total += info.Size()
		files = append(files, cacheFile{path: path, info: info})
		return nil
	})
	if err != nil {
		return err
	}
	sort.Slice(files, func(i, j int) bool { return files[i].info.ModTime().Before(files[j].info.ModTime()) })
	for _, file := range files {
		if total <= s.max {
			return nil
		}
		if s.open[file.path] != 0 {
			continue
		}
		if err := os.Remove(file.path); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return err
		}
		total -= file.info.Size()
	}
	if total > s.max {
		return ErrDiskLimit
	}
	return nil
}
