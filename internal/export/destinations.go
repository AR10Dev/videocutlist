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
		root, err := filepath.Abs(d.MediaRoot)
		if err != nil {
			return "", err
		}
		sourceAbs, err := filepath.Abs(source)
		if err != nil {
			return "", err
		}
		rel, err := filepath.Rel(root, sourceAbs)
		if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return "", errors.New("source is outside destination media root")
		}
		return filepath.Join(filepath.Dir(sourceAbs), ".videocutlist-exports"), nil
	}
	return "", errors.New("unsupported destination kind")
}

func prepareDestinationRoot(path string) (string, error) {
	if err := os.MkdirAll(path, 0o750); err != nil {
		return "", err
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return "", err
	}
	parent, err := filepath.EvalSymlinks(filepath.Dir(path))
	if err != nil {
		return "", err
	}
	rel, err := filepath.Rel(parent, resolved)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", errors.New("destination escapes configured root")
	}
	return resolved, nil
}
