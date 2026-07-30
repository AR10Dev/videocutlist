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
	"sort"
	"strings"

	"editapp/internal/media/probe"
)

var (
	ErrNotFound      = errors.New("media not found")
	ErrOutsideRoot   = errors.New("media is outside configured root")
	ErrSourceChanged = errors.New("media changed since indexing")
)

type Root struct {
	Alias string
	Path  string

	canonical string
}

// Media intentionally omits root and relative path so callers cannot return
// original filesystem paths to clients.
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

type Scanner struct {
	roots  map[string]Root
	prober probe.Runner
}

func NewScanner(roots []Root, prober probe.Runner) (*Scanner, error) {
	if prober == nil {
		return nil, errors.New("media prober is required")
	}
	s := &Scanner{roots: make(map[string]Root, len(roots)), prober: prober}
	for _, root := range roots {
		if root.Alias == "" || root.Path == "" {
			return nil, errors.New("media root alias and path are required")
		}
		if _, ok := s.roots[root.Alias]; ok {
			return nil, fmt.Errorf("duplicate media root alias %q", root.Alias)
		}
		canonical, err := filepath.EvalSymlinks(root.Path)
		if err != nil {
			return nil, fmt.Errorf("resolve media root %q: %w", root.Alias, err)
		}
		info, err := os.Stat(canonical)
		if err != nil || !info.IsDir() {
			return nil, fmt.Errorf("media root %q is not a directory", root.Alias)
		}
		root.canonical = canonical
		s.roots[root.Alias] = root
	}
	return s, nil
}

func MediaID(rootAlias, relativePath string) string {
	relativePath = filepath.ToSlash(filepath.Clean(relativePath))
	sum := sha256.Sum256([]byte(rootAlias + "\x00" + relativePath))
	return "m_" + base64.RawURLEncoding.EncodeToString(sum[:])
}

func (s *Scanner) Scan(ctx context.Context, alias string) ([]Record, error) {
	root, ok := s.roots[alias]
	if !ok {
		return nil, ErrNotFound
	}
	var records []Record
	err := filepath.WalkDir(root.canonical, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if entry.IsDir() || !isMediaPath(path) {
			return nil
		}
		resolved, info, err := resolve(root, path)
		if errors.Is(err, ErrOutsideRoot) || errors.Is(err, fs.ErrNotExist) {
			return nil // A deleted file or symlink escape is never indexed.
		}
		if err != nil || !info.Mode().IsRegular() {
			return nil
		}
		metadata, err := s.prober.Probe(ctx, resolved)
		if err != nil {
			return nil // Corrupt and unsupported files are not usable media.
		}
		relative, err := filepath.Rel(root.canonical, path)
		if err != nil {
			return err
		}
		records = append(records, Record{
			Media:     Media{ID: MediaID(root.Alias, relative), Name: filepath.Base(relative), SizeBytes: info.Size(), MtimeNS: info.ModTime().UnixNano(), Metadata: metadata},
			RootAlias: root.Alias, RelativePath: filepath.ToSlash(relative),
		})
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("scan media root %q: %w", alias, err)
	}
	sort.Slice(records, func(i, j int) bool { return records[i].ID < records[j].ID })
	return records, nil
}

func (s *Scanner) Refresh(ctx context.Context, catalog Catalog) error {
	if catalog == nil {
		return errors.New("media catalog is required")
	}
	aliases := make([]string, 0, len(s.roots))
	for alias := range s.roots {
		aliases = append(aliases, alias)
	}
	sort.Strings(aliases)
	for _, alias := range aliases {
		records, err := s.Scan(ctx, alias)
		if err != nil {
			return err
		}
		if err := catalog.Sync(ctx, alias, records); err != nil {
			return err
		}
	}
	return nil
}

// Open resolves a catalog record server-side and returns an open file, never a
// filesystem path. Callers must close the returned reader.
func (s *Scanner) Open(ctx context.Context, catalog Catalog, id string) (io.ReadCloser, Media, error) {
	record, err := catalog.Get(ctx, id)
	if err != nil {
		return nil, Media{}, err
	}
	root, ok := s.roots[record.RootAlias]
	if !ok {
		return nil, Media{}, ErrNotFound
	}
	path, info, err := resolve(root, filepath.Join(root.canonical, filepath.FromSlash(record.RelativePath)))
	if err != nil {
		return nil, Media{}, err
	}
	if info.Size() != record.SizeBytes || info.ModTime().UnixNano() != record.MtimeNS {
		return nil, Media{}, ErrSourceChanged
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, Media{}, err
	}
	return file, record.Media, nil
}

func resolve(root Root, candidate string) (string, fs.FileInfo, error) {
	resolved, err := filepath.EvalSymlinks(candidate)
	if err != nil {
		return "", nil, err
	}
	relative, err := filepath.Rel(root.canonical, resolved)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) || filepath.IsAbs(relative) {
		return "", nil, ErrOutsideRoot
	}
	info, err := os.Stat(resolved)
	if err != nil {
		return "", nil, err
	}
	return resolved, info, nil
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
