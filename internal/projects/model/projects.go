package model

import (
	"cmp"
	"errors"
	"fmt"
	"math"
	"regexp"
	"slices"
	"strings"
	"unicode/utf8"
)

var (
	mediaIDPattern       = regexp.MustCompile(`^m_[A-Za-z0-9_-]{43}$`)
	projectItemIDPattern = regexp.MustCompile(`^i_[A-Za-z0-9_-]{24}$`)
)

const ProjectSchemaVersion = 2

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
	ExportOptions ExportOptions `json:"exportOptions,omitzero"`
}

// Document is the editable project payload; revision belongs to its envelope.
type Document struct {
	SchemaVersion int           `json:"schemaVersion"`
	Name          string        `json:"name"`
	Items         []ProjectItem `json:"items"`
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
		if err := ValidateProjectItem(item, -1); err != nil {
			return fmt.Errorf("item %d: %w", i, err)
		}
	}
	return nil
}

// ValidateProjectItem checks an item's editor and export state. A negative
// duration skips the catalog-backed segment bound check.
func ValidateProjectItem(item ProjectItem, durationMS int64) error {
	if err := validateSegments(item.Segments, durationMS); err != nil {
		return err
	}
	if item.EditorState != nil && (item.EditorState.PlayheadMS < 0 || (durationMS >= 0 && item.EditorState.PlayheadMS > durationMS) || item.EditorState.Zoom <= 0 || math.IsNaN(item.EditorState.Zoom) || math.IsInf(item.EditorState.Zoom, 0)) {
		return errors.New("invalid editor state")
	}
	if err := validateExportOptions(item.ExportOptions); err != nil {
		return err
	}
	return nil
}

func validateExportOptions(options ExportOptions) error {
	if options.Mode != "" && options.Mode != "merge" && options.Mode != "separate" {
		return errors.New("invalid export mode")
	}
	if options.Selection != "" && options.Selection != "segments" && options.Selection != "gaps" {
		return errors.New("invalid export selection")
	}
	if options.CutStrategy != "" && options.CutStrategy != "stream_copy_preferred" && options.CutStrategy != "precise_reencode" && options.CutStrategy != "hybrid_smart_cut" {
		return errors.New("invalid export cut strategy")
	}
	if options.Container != "" && options.Container != "mkv" {
		return errors.New("invalid export container")
	}
	if len(options.DestinationID) > 64 || len(options.FilenameTemplate) > 160 || strings.ContainsAny(options.DestinationID, "/\\") || strings.Contains(options.FilenameTemplate, "\x00") {
		return errors.New("invalid export destination")
	}
	seen := make(map[int]struct{}, len(options.StreamIndexes))
	for _, index := range options.StreamIndexes {
		if index < 0 {
			return errors.New("invalid export stream index")
		}
		if _, ok := seen[index]; ok {
			return errors.New("duplicate export stream index")
		}
		seen[index] = struct{}{}
	}
	return nil
}

func validateSegments(segments []Segment, durationMS int64) error {
	ordered := slices.Clone(segments)
	slices.SortStableFunc(ordered, func(a, b Segment) int { return cmp.Compare(a.StartMS, b.StartMS) })
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
