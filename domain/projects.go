package domain

import (
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"
)

var (
	mediaIDPattern       = regexp.MustCompile(`^m_[A-Za-z0-9_-]{43}$`)
	projectItemIDPattern = regexp.MustCompile(`^i_[A-Za-z0-9_-]{24}$`)
)

const ProjectSchemaVersion = 2

var ErrLegacyProjectItemCount = errors.New("legacy project operations require exactly one item")

type Segment struct {
	StartMS int64  `json:"startMs"`
	EndMS   int64  `json:"endMs"`
	Label   string `json:"label,omitempty"`
}

type UIState struct {
	PlayheadMS int64   `json:"playheadMs"`
	Zoom       float64 `json:"zoom"`
	Muted      bool    `json:"muted"`
}

// ExportOptions are the project-item settings that become an export snapshot.
type ExportOptions struct {
	Mode             string `json:"mode,omitempty"`
	Selection        string `json:"selection,omitempty"`
	StreamIndexes    []int  `json:"streamIndexes,omitempty"`
	CutStrategy      string `json:"cutStrategy,omitempty"`
	Container        string `json:"container,omitempty"`
	DestinationID    string `json:"destinationId,omitempty"`
	FilenameTemplate string `json:"filenameTemplate,omitempty"`
}

type ProjectItem struct {
	ID            string        `json:"id"`
	MediaID       string        `json:"mediaId"`
	Segments      []Segment     `json:"segments"`
	EditorState   *UIState      `json:"editorState,omitempty"`
	ExportOptions ExportOptions `json:"exportOptions,omitempty"`
}

// Document is the editable project payload. Revision is deliberately stored in
// the project envelope, not this document.
type Document struct {
	SchemaVersion int           `json:"schemaVersion"`
	Name          string        `json:"name"`
	Items         []ProjectItem `json:"items"`

	// Transitional fields keep pre-batch export and interchange internals
	// compiling. They are never serialized or persisted as a project document.
	MediaID  string    `json:"-"`
	Revision int64     `json:"-"`
	Segments []Segment `json:"-"`
	UIState  UIState   `json:"-"`
}

func StableProjectItemID(projectID string) string {
	sum := sha256.Sum256([]byte(projectID))
	return "i_" + base64.RawURLEncoding.EncodeToString(sum[:18])
}

// LegacyProject adapts a one-item batch for callers not yet moved to item APIs.
// It rejects multi-item projects rather than choosing one implicitly.
func LegacyProject(document Document) (Document, error) {
	if len(document.Items) != 1 {
		return Document{}, ErrLegacyProjectItemCount
	}
	item := document.Items[0]
	document.MediaID = item.MediaID
	document.Segments = append([]Segment(nil), item.Segments...)
	if item.EditorState != nil {
		document.UIState = *item.EditorState
	}
	return document, nil
}

// ReplaceLegacySegments updates the sole batch item used by a legacy operation.
func ReplaceLegacySegments(document Document, segments []Segment) (Document, error) {
	document, err := LegacyProject(document)
	if err != nil {
		return Document{}, err
	}
	document.Items[0].Segments = append([]Segment(nil), segments...)
	document.Segments = append([]Segment(nil), segments...)
	return document, nil
}

// ValidateProject checks document-only invariants. Item media duration checks
// happen where a media catalog is available.
func ValidateProject(document Document) error {
	if document.SchemaVersion != ProjectSchemaVersion {
		return errors.New("unsupported project schema version")
	}
	if strings.TrimSpace(document.Name) == "" {
		return errors.New("project name is required")
	}
	if len(document.Items) == 0 {
		return errors.New("project must contain an item")
	}
	seen := make(map[string]struct{}, len(document.Items))
	for i, item := range document.Items {
		if !projectItemIDPattern.MatchString(item.ID) {
			return fmt.Errorf("item %d has an invalid ID", i)
		}
		if !mediaIDPattern.MatchString(item.MediaID) {
			return fmt.Errorf("item %d has an invalid media ID", i)
		}
		if _, ok := seen[item.ID]; ok {
			return fmt.Errorf("item %d duplicates an item ID", i)
		}
		seen[item.ID] = struct{}{}
		if err := validateSegments(item.Segments, -1); err != nil {
			return fmt.Errorf("item %d: %w", i, err)
		}
		if item.EditorState != nil && (item.EditorState.PlayheadMS < 0 || item.EditorState.Zoom <= 0 || math.IsNaN(item.EditorState.Zoom) || math.IsInf(item.EditorState.Zoom, 0)) {
			return fmt.Errorf("item %d has invalid editor state", i)
		}
	}
	return nil
}

// Validate is retained for legacy single-media execution paths. New project
// saves use ValidateProject plus catalog-backed per-item duration validation.
func Validate(document Document, durationMS int64) error {
	if !mediaIDPattern.MatchString(document.MediaID) {
		return errors.New("invalid media ID")
	}
	if document.Revision < 0 {
		return errors.New("revision must be non-negative")
	}
	if durationMS <= 0 {
		return errors.New("media duration must be positive")
	}
	if document.UIState.PlayheadMS < 0 || document.UIState.PlayheadMS > durationMS {
		return errors.New("playhead is outside media duration")
	}
	if document.UIState.Zoom <= 0 || math.IsNaN(document.UIState.Zoom) || math.IsInf(document.UIState.Zoom, 0) {
		return errors.New("zoom must be positive")
	}
	return validateSegments(document.Segments, durationMS)
}

func validateSegments(segments []Segment, durationMS int64) error {
	ordered := append([]Segment(nil), segments...)
	sort.SliceStable(ordered, func(i, j int) bool { return ordered[i].StartMS < ordered[j].StartMS })
	var previousEnd int64
	for i, segment := range ordered {
		if segment.StartMS < 0 || segment.StartMS >= segment.EndMS || (durationMS >= 0 && segment.EndMS > durationMS) {
			return fmt.Errorf("segment %d is outside media duration", i)
		}
		if i > 0 && segment.StartMS < previousEnd {
			return fmt.Errorf("segment %d overlaps a previous segment", i)
		}
		if utf8.RuneCountInString(segment.Label) > 200 {
			return fmt.Errorf("segment %d label exceeds 200 characters", i)
		}
		previousEnd = segment.EndMS
	}
	return nil
}
