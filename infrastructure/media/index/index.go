// Package index scans configured media roots without exposing source paths.
package index

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"

	"videocutlist/infrastructure/media/probe"
)

var (
	ErrNotFound      = errors.New("media not found")
	ErrOutsideRoot   = errors.New("media is outside configured root")
	ErrSourceChanged = errors.New("media changed since indexing")
	ErrScanLimit     = errors.New("media scan limit exceeded")
	validAlias       = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`)
)

// ScanLimits bounds work performed by a server-side import. Zero values use
// conservative defaults so an accidental unbounded walk is never possible.
type ScanLimits struct {
	MaxFiles int
	MaxDepth int
}

const (
	defaultMaxFiles = 10000
	defaultMaxDepth = 32
)

type Root struct {
	Alias string
	Path  string

	handle *os.Root
}

// Media intentionally omits root and relative path so callers cannot return
// original filesystem paths to clients.
type Folder struct {
	ID    string `json:"id"`
	Label string `json:"label"`
}

type Media struct {
	ID        string         `json:"id"`
	Name      string         `json:"name"`
	SizeBytes int64          `json:"sizeBytes"`
	MtimeNS   int64          `json:"mtimeNs"`
	Metadata  probe.Metadata `json:"metadata"`
}

type Record struct {
	Media
	RootAlias    string
	RelativePath string
}

type Page struct {
	Items      []Media `json:"items"`
	NextCursor string  `json:"nextCursor,omitempty"`
}

// Catalog is implemented by the SQLite media store. It deliberately has no
// pathname-returning method.
type Catalog interface {
	Sync(context.Context, string, []Record) error
	Get(context.Context, string) (Record, error)
	List(context.Context, string, int) (Page, error)
}

type RootStatus struct {
	State     string `json:"state"`
	ErrorCode string `json:"errorCode,omitempty"`
}

type Scanner struct {
	roots    map[string]Root
	prober   probe.Runner
	limits   ScanLimits
	mu       sync.Mutex
	config   sync.RWMutex
	statusMu sync.RWMutex
	status   map[string]RootStatus
}

func NewScanner(roots []Root, prober probe.Runner) (*Scanner, error) {
	return NewScannerWithLimits(roots, prober, ScanLimits{})
}

func NewScannerWithLimits(roots []Root, prober probe.Runner, limits ScanLimits) (*Scanner, error) {
	if prober == nil {
		return nil, errors.New("media prober is required")
	}
	if limits.MaxFiles <= 0 {
		limits.MaxFiles = defaultMaxFiles
	}
	if limits.MaxDepth <= 0 {
		limits.MaxDepth = defaultMaxDepth
	}
	s := &Scanner{roots: make(map[string]Root, len(roots)), prober: prober, limits: limits, status: make(map[string]RootStatus, len(roots))}
	for _, root := range roots {
		if !validAlias.MatchString(root.Alias) {
			return nil, errors.New("media root alias must be a safe label")
		}
		if root.Path == "" {
			return nil, errors.New("media root path is required")
		}
		if _, ok := s.roots[root.Alias]; ok {
			return nil, fmt.Errorf("duplicate media root alias %q", root.Alias)
		}
		s.roots[root.Alias] = root
		s.status[root.Alias] = RootStatus{State: "ready_empty"}
	}
	return s, nil
}

func FolderID(rootAlias, relativePath string) string {
	relativePath = filepath.ToSlash(filepath.Clean(relativePath))
	sum := sha256.Sum256([]byte(rootAlias + "\x00" + relativePath))
	return "f_" + base64.RawURLEncoding.EncodeToString(sum[:])
}

func MediaID(rootAlias, relativePath string) string {
	relativePath = filepath.ToSlash(filepath.Clean(relativePath))
	sum := sha256.Sum256([]byte(rootAlias + "\x00" + relativePath))
	return "m_" + base64.RawURLEncoding.EncodeToString(sum[:])
}

func (s *Scanner) Scan(ctx context.Context, alias string) ([]Record, error) {
	s.config.RLock()
	defer s.config.RUnlock()
	root, err := s.root(alias)
	if err != nil {
		return nil, err
	}
	var records []Record
	err = fs.WalkDir(root.handle.FS(), ".", func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if entry.IsDir() {
			if strings.Count(filepath.ToSlash(path), "/") > s.limits.MaxDepth {
				return fs.SkipDir
			}
			if filepath.Base(path) == ".videocutlist-exports" {
				return fs.SkipDir
			}
			return nil
		}
		if !isMediaPath(path) {
			return nil
		}
		if len(records) >= s.limits.MaxFiles {
			return ErrScanLimit
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return nil
		}
		file, info, err := openMedia(root, path)
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			_ = file.Close()
			return nil
		}
		metadata, err := s.prober.ProbeFile(ctx, file)
		closeErr := file.Close()
		if err != nil {
			return err
		}
		if closeErr != nil {
			return closeErr
		}
		records = append(records, Record{
			Media:     Media{ID: MediaID(root.Alias, path), Name: filepath.Base(path), SizeBytes: info.Size(), MtimeNS: info.ModTime().UnixNano(), Metadata: metadata},
			RootAlias: root.Alias, RelativePath: filepath.ToSlash(path),
		})
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("scan media root %q: %w", alias, err)
	}
	sort.Slice(records, func(i, j int) bool { return records[i].ID < records[j].ID })
	return records, nil
}

// ReconfigureLimits applies scan bounds to scans started after this call.
func (s *Scanner) ReconfigureLimits(limits ScanLimits) error {
	if limits.MaxFiles < 1 || limits.MaxDepth < 1 {
		return errors.New("scan limits must be positive")
	}
	s.config.Lock()
	s.limits = limits
	s.config.Unlock()
	return nil
}

// RootCatalog atomically hides records from removed media roots.
type RootCatalog interface {
	RemoveRoots(context.Context, []string) error
}

// Reconfigure validates and atomically replaces the active roots. Existing
// open requests retain the old snapshot; new requests use the new snapshot.
// The optional allowlist is checked after symlink resolution.
func (s *Scanner) Reconfigure(ctx context.Context, roots []Root, allowlist []string, catalog Catalog) error {
	validated, err := validateRoots(roots, allowlist)
	if err != nil {
		return err
	}
	s.config.Lock()
	s.mu.Lock()
	removed := make([]string, 0)
	for alias := range s.roots {
		found := false
		for _, root := range validated {
			if root.Alias == alias {
				found = true
				break
			}
		}
		if !found {
			removed = append(removed, alias)
		}
	}
	if remover, ok := catalog.(RootCatalog); ok && len(removed) > 0 {
		if err := remover.RemoveRoots(ctx, removed); err != nil {
			s.mu.Unlock()
			s.config.Unlock()
			return err
		}
	}
	for _, root := range s.roots {
		if root.handle != nil {
			_ = root.handle.Close()
		}
	}
	s.roots = make(map[string]Root, len(validated))
	for _, root := range validated {
		s.roots[root.Alias] = root
	}
	s.statusMu.Lock()
	s.status = make(map[string]RootStatus, len(validated))
	for _, root := range validated {
		s.status[root.Alias] = RootStatus{State: "ready_empty"}
	}
	s.statusMu.Unlock()
	s.mu.Unlock()
	s.config.Unlock()
	return nil
}

func validateRoots(roots []Root, allowlist []string) ([]Root, error) {
	allowed := make([]string, len(allowlist))
	for i, base := range allowlist {
		if !filepath.IsAbs(base) {
			return nil, fmt.Errorf("media root allowlist must contain absolute directories")
		}
		canonical, err := filepath.EvalSymlinks(base)
		if err != nil {
			return nil, errors.New("media root allowlist contains an invalid directory")
		}
		allowed[i] = filepath.Clean(canonical)
	}
	result := make([]Root, 0, len(roots))
	seen := make(map[string]struct{}, len(roots))
	for _, root := range roots {
		if !validAlias.MatchString(root.Alias) || !filepath.IsAbs(root.Path) {
			return nil, errors.New("media root alias must be a safe label and path must be absolute")
		}
		if _, ok := seen[root.Alias]; ok {
			return nil, fmt.Errorf("duplicate media root alias %q", root.Alias)
		}
		canonical, err := filepath.EvalSymlinks(root.Path)
		if err != nil {
			return nil, fmt.Errorf("media root %q is not a valid directory", root.Alias)
		}
		info, err := os.Stat(canonical)
		if err != nil || !info.IsDir() {
			return nil, fmt.Errorf("media root %q must be a readable directory", root.Alias)
		}
		directory, err := os.Open(canonical)
		if err != nil {
			return nil, fmt.Errorf("media root %q is not readable", root.Alias)
		}
		_ = directory.Close()
		if len(allowed) > 0 && !underAnyRoot(canonical, allowed) {
			return nil, fmt.Errorf("media root %q is outside the deployment allowlist", root.Alias)
		}
		seen[root.Alias] = struct{}{}
		result = append(result, Root{Alias: root.Alias, Path: filepath.Clean(canonical)})
	}
	return result, nil
}

func underAnyRoot(path string, bases []string) bool {
	for _, base := range bases {
		rel, err := filepath.Rel(base, path)
		if err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return true
		}
	}
	return false
}

func (s *Scanner) root(alias string) (Root, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	root, ok := s.roots[alias]
	if !ok {
		return Root{}, ErrNotFound
	}
	if root.handle == nil {
		handle, err := os.OpenRoot(root.Path)
		if err != nil {
			return Root{}, fmt.Errorf("open media root %q: %w", alias, err)
		}
		root.handle = handle
		s.roots[alias] = root
	}
	return root, nil
}

func (s *Scanner) RootStatuses() map[string]RootStatus {
	s.statusMu.RLock()
	defer s.statusMu.RUnlock()
	result := make(map[string]RootStatus, len(s.status))
	for alias, status := range s.status {
		result[alias] = status
	}
	return result
}

func (s *Scanner) setRootStatus(alias string, status RootStatus) {
	s.statusMu.Lock()
	s.status[alias] = status
	s.statusMu.Unlock()
}

func rootErrorCode(err error) string {
	switch {
	case errors.Is(err, ErrScanLimit):
		return "scan_limit"
	case errors.Is(err, context.Canceled):
		return "cancelled"
	default:
		return "scan_failed"
	}
}

func (s *Scanner) Refresh(ctx context.Context, catalog Catalog) error {
	s.config.RLock()
	defer s.config.RUnlock()
	if catalog == nil {
		return errors.New("media catalog is required")
	}
	s.mu.Lock()
	aliases := make([]string, 0, len(s.roots))
	for alias := range s.roots {
		aliases = append(aliases, alias)
	}
	s.mu.Unlock()
	sort.Strings(aliases)
	var firstErr error
	for _, alias := range aliases {
		s.setRootStatus(alias, RootStatus{State: "scanning"})
		records, err := s.Scan(ctx, alias)
		if err != nil {
			s.setRootStatus(alias, RootStatus{State: "failed", ErrorCode: rootErrorCode(err)})
			if firstErr == nil {
				firstErr = err
			}
			if ctx.Err() != nil {
				break
			}
			continue
		}
		if err := catalog.Sync(ctx, alias, records); err != nil {
			s.setRootStatus(alias, RootStatus{State: "failed", ErrorCode: rootErrorCode(err)})
			if firstErr == nil {
				firstErr = err
			}
			if ctx.Err() != nil {
				break
			}
			continue
		}
		state := "ready_with_media"
		if len(records) == 0 {
			state = "ready_empty"
		}
		s.setRootStatus(alias, RootStatus{State: state})
	}
	return firstErr
}

// Open resolves a catalog record server-side and returns an open file, never a
// filesystem path. Callers must close the returned reader.
func (s *Scanner) Open(ctx context.Context, catalog Catalog, id string) (io.ReadCloser, Media, error) {
	s.config.RLock()
	defer s.config.RUnlock()
	record, err := catalog.Get(ctx, id)
	if err != nil {
		return nil, Media{}, err
	}
	root, err := s.root(record.RootAlias)
	if err != nil {
		return nil, Media{}, err
	}
	file, info, err := openMedia(root, record.RelativePath)
	if err != nil {
		return nil, Media{}, err
	}
	if !info.Mode().IsRegular() || info.Size() != record.SizeBytes || info.ModTime().UnixNano() != record.MtimeNS {
		_ = file.Close()
		return nil, Media{}, ErrSourceChanged
	}
	return file, record.Media, nil
}

// openMedia resolves a relative path beneath the root's persistent descriptor,
// then stats that exact descriptor. os.Root rejects escapes even if a symlink
// changes while it is being resolved.
func openMedia(root Root, relative string) (*os.File, fs.FileInfo, error) {
	if root.handle == nil {
		return nil, nil, ErrNotFound
	}
	name := filepath.Clean(filepath.FromSlash(relative))
	if name == "." || filepath.IsAbs(name) || name == ".." || strings.HasPrefix(name, ".."+string(filepath.Separator)) {
		return nil, nil, ErrOutsideRoot
	}
	file, err := root.handle.Open(name)
	if err != nil {
		return nil, nil, err
	}
	info, err := file.Stat()
	if err != nil {
		_ = file.Close()
		return nil, nil, err
	}
	return file, info, nil
}

func isMediaPath(path string) bool {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".avi", ".m2ts", ".m4v", ".mkv", ".mov", ".mp4", ".mpeg", ".mpg", ".mts", ".ts", ".webm":
		return true
	default:
		return false
	}
}

// SourceFingerprint is the cache invalidation identity from the runtime contract.
func SourceFingerprint(media Media) string {
	return fmt.Sprintf("%s:%d:%d", media.ID, media.SizeBytes, media.MtimeNS)
}
