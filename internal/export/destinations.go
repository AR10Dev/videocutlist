package export

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"unicode"
)

const (
	KindDownload       = "download"
	KindArchive        = "archive"
	KindSourceAdjacent = "source_adjacent"
)

type Destination struct {
	ID            string        `json:"id"`
	Label         string        `json:"label"`
	Description   string        `json:"description,omitempty"`
	Kind          string        `json:"kind"`
	Root          string        `json:"root,omitempty"`
	Retention     time.Duration `json:"-"`
	RetentionText string        `json:"retention,omitempty"`
	MediaRoot     string        `json:"mediaRoot,omitempty"`
}

type PublicDestination struct{ ID, Label, Description, Kind, Retention string }

// SourceLocation is the server-side identity of an indexed source. It is never
// serialized into an API request or response.
type SourceLocation struct {
	RootPath     string `json:"-"`
	RelativePath string `json:"-"`
}

type preparedDestination struct {
	path      string
	root      *os.Root
	directory *os.File
}

func (p preparedDestination) close() {
	if p.directory != nil {
		_ = p.directory.Close()
	}
	if p.root != nil {
		_ = p.root.Close()
	}
}

func createRootTemp(root *os.Root, prefix, suffix string) (*os.File, string, error) {
	for range 100 {
		name := prefix + uniqueSuffix() + suffix
		file, err := root.OpenFile(name, os.O_RDWR|os.O_CREATE|os.O_EXCL, 0o600)
		if err == nil {
			return file, name, nil
		}
		if !errors.Is(err, os.ErrExist) {
			return nil, "", err
		}
	}
	return nil, "", errors.New("could not create temporary destination file")
}

func (p preparedDestination) createTemp(prefix, suffix string) (*os.File, string, error) {
	file, name, err := createRootTemp(p.root, prefix, suffix)
	if err != nil {
		return nil, "", err
	}
	return file, name, nil
}

func (p preparedDestination) createTempDir(prefix string) (*os.Root, *os.File, string, error) {
	for range 100 {
		name := prefix + uniqueSuffix()
		if err := p.root.Mkdir(name, 0o700); err != nil {
			if errors.Is(err, os.ErrExist) {
				continue
			}
			return nil, nil, "", err
		}
		root, err := p.root.OpenRoot(name)
		if err != nil {
			p.removeAll(name)
			return nil, nil, "", err
		}
		directory, err := root.Open(".")
		if err != nil {
			_ = root.Close()
			p.removeAll(name)
			return nil, nil, "", err
		}
		return root, directory, name, nil
	}
	return nil, nil, "", errors.New("could not create temporary destination directory")
}

func (p preparedDestination) remove(name string)    { _ = p.root.Remove(name) }
func (p preparedDestination) removeAll(name string) { _ = p.root.RemoveAll(name) }
func (p preparedDestination) writable() error {
	info, err := p.root.Stat(".")
	if err != nil {
		return err
	}
	if info.Mode().Perm()&0o222 == 0 {
		return errors.New("destination is not writable")
	}
	return nil
}
func (p preparedDestination) publish(tempName, outputName string) error {
	return p.publishFrom(p.directory, tempName, tempName, outputName)
}

func (p preparedDestination) publishFrom(sourceDirectory *os.File, sourceRootName, tempName, outputName string) error {
	if p.root == nil || p.directory == nil || sourceDirectory == nil {
		return errors.New("destination directory is not open")
	}
	return publishOpenedNoReplace(sourceDirectory, p.directory, tempName, outputName, p.root, sourceRootName)
}

func (d Destination) Public() PublicDestination {
	return PublicDestination{d.ID, d.Label, d.Description, d.Kind, d.RetentionText}
}

var templatePattern = regexp.MustCompile(`\{([a-z]+)\}`)
var templateVariables = map[string]bool{"source": true, "date": true, "time": true, "segment": true, "mode": true, "ext": true}

func RenderTemplate(t string, values map[string]string) (string, error) {
	if t == "" {
		return "", nil
	}
	if len(t) > 160 {
		return "", errors.New("filename template is too long")
	}
	matches := templatePattern.FindAllStringSubmatchIndex(t, -1)
	covered := make([]bool, len(t))
	for _, match := range matches {
		start, end := match[0], match[1]
		for i := start; i < end; i++ {
			covered[i] = true
		}
		name := t[match[2]:match[3]]
		if !templateVariables[name] {
			return "", fmt.Errorf("unknown filename variable %q", name)
		}
		if values[name] == "" {
			return "", fmt.Errorf("filename variable %q is not applicable", name)
		}
	}
	for i, r := range t {
		if (r == '{' || r == '}') && !covered[i] {
			return "", errors.New("malformed filename template")
		}
	}
	rendered := templatePattern.ReplaceAllStringFunc(t, func(token string) string { return values[token[1:len(token)-1]] })
	rendered = sanitizeName(rendered)
	if rendered == "" || rendered == "." || rendered == ".." {
		return "", errors.New("filename template produces an empty name")
	}
	return rendered, nil
}
func sanitizeName(value string) string {
	var b strings.Builder
	for _, r := range value {
		if unicode.IsLetter(r) || unicode.IsDigit(r) || strings.ContainsRune(" .-_", r) {
			b.WriteRune(r)
		} else {
			b.WriteByte('_')
		}
	}
	return strings.Trim(strings.ReplaceAll(b.String(), " ", "_"), "._")
}
func uniqueSuffix() string {
	var b [9]byte
	if _, err := rand.Read(b[:]); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(b[:])
}
func destinationRoot(d Destination, source string) (string, error) {
	return destinationRootAt(d, source, SourceLocation{})
}

func destinationRootAt(d Destination, source string, location SourceLocation) (string, error) {
	switch d.Kind {
	case KindDownload, KindArchive:
		if d.Root == "" {
			return "", errors.New("destination root is required")
		}
		return filepath.Clean(d.Root), nil
	case KindSourceAdjacent:
		if d.MediaRoot == "" {
			return "", errors.New("source-adjacent media root is required")
		}
		sourcePath, err := resolveSourcePath(d.MediaRoot, source, location)
		if err != nil {
			return "", err
		}
		return filepath.Join(filepath.Dir(sourcePath), ".videocutlist-exports"), nil
	default:
		return "", errors.New("unsupported destination kind")
	}
}

func prepareDestination(d Destination, source *os.File, sourceName string, location SourceLocation) (preparedDestination, error) {
	fallback := sourceName
	if source != nil && location.RootPath == "" && location.RelativePath == "" {
		fallback = source.Name()
	}
	path, err := destinationRootAt(d, fallback, location)
	if err != nil {
		return preparedDestination{}, err
	}
	if d.Kind == KindSourceAdjacent {
		prepared, err := prepareDestinationWithin(path, d.MediaRoot)
		if err != nil {
			return preparedDestination{}, err
		}
		if err := prepared.writable(); err != nil {
			prepared.close()
			return preparedDestination{}, err
		}
		if source != nil {
			resolvedSourcePath, err := resolveSourcePath(d.MediaRoot, source.Name(), location)
			if err != nil {
				prepared.close()
				return preparedDestination{}, errors.New("source changed")
			}
			resolvedSource, err := os.Open(resolvedSourcePath)
			if err != nil {
				prepared.close()
				return preparedDestination{}, errors.New("source changed")
			}
			defer resolvedSource.Close()
			fdInfo, fdErr := source.Stat()
			pathInfo, pathErr := resolvedSource.Stat()
			if fdErr != nil || pathErr != nil || !os.SameFile(fdInfo, pathInfo) {
				prepared.close()
				return preparedDestination{}, errors.New("source changed")
			}
		}
		return prepared, nil
	}
	resolved, err := prepareDestinationRoot(path)
	if err != nil {
		return preparedDestination{}, err
	}
	root, err := os.OpenRoot(resolved)
	if err != nil {
		return preparedDestination{}, err
	}
	directory, err := root.Open(".")
	if err != nil {
		_ = root.Close()
		return preparedDestination{}, err
	}
	prepared := preparedDestination{path: resolved, root: root, directory: directory}
	if err := prepared.writable(); err != nil {
		prepared.close()
		return preparedDestination{}, err
	}
	return prepared, nil
}

func resolveSourcePath(mediaRoot, fallback string, location SourceLocation) (string, error) {
	root, err := canonicalDirectory(mediaRoot)
	if err != nil {
		return "", err
	}
	var source string
	if location.RootPath != "" || location.RelativePath != "" {
		if location.RootPath == "" || location.RelativePath == "" {
			return "", errors.New("source location is incomplete")
		}
		sourceRoot, err := canonicalDirectory(location.RootPath)
		if err != nil {
			return "", errors.New("source root is unavailable")
		}
		if !underRoot(sourceRoot, root) {
			return "", errors.New("source is outside destination media root")
		}
		relative := filepath.Clean(filepath.FromSlash(location.RelativePath))
		if !safeRelativePath(relative) {
			return "", errors.New("source path is invalid")
		}
		source = filepath.Join(sourceRoot, relative)
	} else {
		if fallback == "" {
			return "", errors.New("source location is required")
		}
		source, err = filepath.Abs(fallback)
		if err != nil {
			return "", err
		}
	}
	resolved, err := filepath.EvalSymlinks(source)
	if err != nil {
		return "", errors.New("source is unavailable")
	}
	if !underRoot(resolved, root) {
		return "", errors.New("source is outside destination media root")
	}
	info, err := os.Stat(resolved)
	if err != nil || !info.Mode().IsRegular() {
		return "", errors.New("source is unavailable")
	}
	return resolved, nil
}

func canonicalDirectory(path string) (string, error) {
	if path == "" {
		return "", errors.New("directory is required")
	}
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	resolved, err := filepath.EvalSymlinks(absolute)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(resolved)
	if err != nil || !info.IsDir() {
		return "", errors.New("directory is unavailable")
	}
	return filepath.Clean(resolved), nil
}

func safeRelativePath(path string) bool {
	return path != "." && !filepath.IsAbs(path) && path != ".." && !strings.HasPrefix(path, ".."+string(filepath.Separator))
}

func underRoot(path, root string) bool {
	relative, err := filepath.Rel(root, path)
	if err != nil {
		return false
	}
	return relative == "." || safeRelativePath(relative)
}

func prepareDestinationWithin(path, allowedRoot string) (preparedDestination, error) {
	rootPath, err := canonicalDirectory(allowedRoot)
	if err != nil {
		return preparedDestination{}, errors.New("destination root is unavailable")
	}
	root, err := os.OpenRoot(rootPath)
	if err != nil {
		return preparedDestination{}, err
	}
	relative, err := filepath.Rel(rootPath, path)
	if err != nil || !safeRelativePath(relative) {
		_ = root.Close()
		return preparedDestination{}, errors.New("destination escapes configured root")
	}
	if _, statErr := root.Stat(relative); errors.Is(statErr, os.ErrNotExist) {
		parent := filepath.Dir(relative)
		parentInfo, parentErr := root.Stat(parent)
		if parentErr != nil || parentInfo.Mode().Perm()&0o222 == 0 {
			_ = root.Close()
			return preparedDestination{}, errors.New("destination is not writable")
		}
	}
	if err := root.MkdirAll(relative, 0o750); err != nil {
		_ = root.Close()
		return preparedDestination{}, err
	}
	info, err := root.Stat(relative)
	if err != nil || !info.IsDir() {
		_ = root.Close()
		return preparedDestination{}, errors.New("destination is unavailable")
	}
	resolved, err := filepath.EvalSymlinks(filepath.Join(rootPath, relative))
	if err != nil || !underRoot(resolved, rootPath) {
		_ = root.Close()
		return preparedDestination{}, errors.New("destination escapes configured root")
	}
	destinationRoot, err := root.OpenRoot(relative)
	_ = root.Close()
	if err != nil {
		return preparedDestination{}, err
	}
	directory, err := destinationRoot.Open(".")
	if err != nil {
		_ = destinationRoot.Close()
		return preparedDestination{}, err
	}
	return preparedDestination{path: filepath.Clean(resolved), root: destinationRoot, directory: directory}, nil
}

func prepareDestinationRoot(path string) (string, error) {
	if err := os.MkdirAll(path, 0o750); err != nil {
		return "", err
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(resolved)
	if err != nil || !info.IsDir() {
		return "", errors.New("destination is unavailable")
	}
	return filepath.Clean(resolved), nil
}
