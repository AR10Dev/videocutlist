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
	"slices"
	"strings"
	"sync"

	"videocutlist/internal/projects/model"
)

var (
	ErrMiss      = model.ErrCacheMiss
	ErrDiskLimit = errors.New("preview cache disk limit exceeded")
)

// Validator is normally backed by FFprobe. It is deliberately supplied by the
// preview pipeline so cache ownership does not duplicate subprocess code.
type Validator = func(context.Context, *os.File) error

type Store struct {
	root string
	max  int64

	mu      sync.Mutex
	open    map[string]int
	partial map[string]struct{}
	paths   map[string]*sync.Mutex
}

func New(root string, maxBytes int64) (*Store, error) {
	if root == "" || maxBytes < 1 {
		return nil, errors.New("cache root and positive byte limit are required")
	}
	if err := os.MkdirAll(filepath.Join(root, "previews"), 0o750); err != nil {
		return nil, fmt.Errorf("create cache directory: %w", err)
	}
	return &Store{root: root, max: maxBytes, open: make(map[string]int), partial: make(map[string]struct{}), paths: make(map[string]*sync.Mutex)}, nil
}

// SetMaxBytes applies the cache policy to writes started after this call.
func (s *Store) SetMaxBytes(maxBytes int64) error {
	if maxBytes < 1 {
		return errors.New("cache limit must be positive")
	}
	s.mu.Lock()
	s.max = maxBytes
	s.mu.Unlock()
	return nil
}

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
	rel, err := RelativePath(key)
	if err != nil {
		return nil, err
	}
	path := filepath.Join(s.root, rel)
	pathMu := s.pathMutex(path)
	pathMu.Lock()
	defer pathMu.Unlock()
	info, err := os.Lstat(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, ErrMiss
	}
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, ErrMiss
	}
	if info.Size() == 0 {
		RemoveFileIfOwned(path, info)
		return nil, ErrMiss
	}
	f, err := os.OpenInRoot(s.root, rel)
	if err != nil {
		// An escaping symlink swapped into place is a miss, not a preview error.
		after, statErr := os.Lstat(path)
		if errors.Is(err, fs.ErrNotExist) || errors.Is(statErr, fs.ErrNotExist) ||
			statErr == nil && (!after.Mode().IsRegular() || !os.SameFile(info, after)) {
			return nil, ErrMiss
		}
		return nil, err
	}
	opened, err := f.Stat()
	if err != nil {
		_ = f.Close()
		return nil, err
	}
	if !opened.Mode().IsRegular() || opened.Size() == 0 || !os.SameFile(info, opened) {
		_ = f.Close()
		return nil, ErrMiss
	}
	if err := validator(ctx, f); err != nil {
		_ = f.Close()
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return nil, err
		}
		// Remove only the rejected inode; a validator may have replaced the path.
		RemoveFileIfOwned(path, opened)
		return nil, ErrMiss
	}
	if err := ctx.Err(); err != nil {
		_ = f.Close()
		return nil, err
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	current, err := os.Lstat(path)
	if errors.Is(err, fs.ErrNotExist) {
		_ = f.Close()
		return nil, ErrMiss
	}
	if err != nil {
		_ = f.Close()
		return nil, err
	}
	if !current.Mode().IsRegular() || current.Size() == 0 || !os.SameFile(info, current) {
		_ = f.Close()
		return nil, ErrMiss
	}
	opened, err = f.Stat()
	if err != nil {
		_ = f.Close()
		return nil, err
	}
	if !opened.Mode().IsRegular() || opened.Size() == 0 || !os.SameFile(info, opened) {
		_ = f.Close()
		return nil, ErrMiss
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		_ = f.Close()
		return nil, err
	}
	// Recency is best-effort metadata; a read-only cache can still serve a hit.
	_ = TouchFile(f)
	s.open[path]++
	return &leasedFile{File: f, done: func() { s.release(path) }}, nil
}

func (s *Store) pathMutex(path string) *sync.Mutex {
	s.mu.Lock()
	defer s.mu.Unlock()
	mutex := s.paths[path]
	if mutex == nil {
		mutex = &sync.Mutex{}
		s.paths[path] = mutex
	}
	return mutex
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

// Commit publishes only the validated partial inode, without replacing another
// writer's complete entry. Failed publication removes only files it still owns.
func (p *Partial) Commit(ctx context.Context, validator Validator) error {
	if validator == nil {
		return errors.New("cache validator is required")
	}
	var result error
	p.once.Do(func() {
		owner, err := p.file.Stat()
		if err != nil {
			result = err
			_ = p.file.Close()
			return
		}
		defer RemoveFileIfOwned(p.path, owner)
		if err := p.file.Sync(); err != nil {
			result = err
			_ = p.file.Close()
			return
		}
		if _, err := p.file.Seek(0, io.SeekStart); err != nil {
			result = err
			_ = p.file.Close()
			return
		}
		if err := validator(ctx, p.file); err != nil {
			result = fmt.Errorf("validate preview cache: %w", err)
			_ = p.file.Close()
			return
		}
		if err := p.file.Close(); err != nil {
			result = err
			return
		}
		// Validators may not observe cancellation (for example, a completed
		// ffprobe); never publish after the request has been cancelled.
		if err := ctx.Err(); err != nil {
			result = err
			return
		}
		final, err := p.store.path(p.key)
		if err != nil {
			result = err
			return
		}
		pathMu := p.store.pathMutex(final)
		pathMu.Lock()
		defer pathMu.Unlock()
		p.store.mu.Lock()
		defer p.store.mu.Unlock()
		// Re-check cancellation while holding both publication locks: cancellation
		// during lock acquisition must not turn into a cache hit.
		if err := ctx.Err(); err != nil {
			result = err
			return
		}
		current, err := os.Lstat(p.path)
		if err != nil || !current.Mode().IsRegular() || !os.SameFile(owner, current) {
			result = errors.New("preview partial changed before publication")
			return
		}
		// Atomic rename publishes only after validation and preserves a winner.
		if err := renameCachePartial(p.path, final); err != nil {
			if !errors.Is(err, fs.ErrExist) {
				result = err
			}
			return
		}
		published, err := os.Lstat(final)
		if err != nil || !published.Mode().IsRegular() || !os.SameFile(owner, published) {
			RemoveFileIfOwned(final, owner)
			result = errors.New("preview partial changed during publication")
			return
		}
		if published.Size() > p.store.max {
			RemoveFileIfOwned(final, owner)
			result = ErrDiskLimit
			return
		}
		if err := p.store.evictLocked(); err != nil {
			RemoveFileIfOwned(final, owner)
			result = err
		}
	})
	p.store.mu.Lock()
	delete(p.store.partial, p.path)
	p.store.mu.Unlock()
	return result
}

// RemoveFileIfOwned checks a cache entry's identity before best-effort removal.
// Callers must serialize their own cache writes.
func RemoveFileIfOwned(path string, owner fs.FileInfo) {
	current, err := os.Lstat(path)
	if err == nil && os.SameFile(owner, current) {
		_ = os.Remove(path)
	}
}

// CleanupPartials removes incomplete files left by a prior process. Active
// partial files in this process are protected by the store lock.
func (s *Store) CleanupPartials() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return filepath.WalkDir(s.root, func(path string, entry fs.DirEntry, err error) error {
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
	slices.SortFunc(files, func(a, b cacheFile) int { return a.info.ModTime().Compare(b.info.ModTime()) })
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
