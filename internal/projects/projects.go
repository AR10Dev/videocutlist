// Package projects validates and persists owner-scoped editing documents.
package projects

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"regexp"
	"unicode/utf8"

	"editapp/internal/store"
)

var mediaIDPattern = regexp.MustCompile(`^m_[A-Za-z0-9_-]{43}$`)

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

type Document struct {
	MediaID  string    `json:"mediaId"`
	Revision int64     `json:"revision"`
	Segments []Segment `json:"segments"`
	UIState  UIState   `json:"uiState"`
}

// Validate implements the frozen project schema plus timeline constraints.
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
	var previousEnd int64
	for i, segment := range document.Segments {
		if segment.StartMS < 0 || segment.StartMS >= segment.EndMS || segment.EndMS > durationMS {
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

// Decode validates the closed JSON schema before turning an API body into a document.
func Decode(data []byte, durationMS int64) (Document, error) {
	var top map[string]json.RawMessage
	decoder := json.NewDecoder(bytes.NewReader(data))
	if err := decoder.Decode(&top); err != nil {
		return Document{}, fmt.Errorf("decode project JSON: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return Document{}, errors.New("project JSON has trailing data")
	}
	if err := exactKeys(top, []string{"mediaId", "revision", "segments", "uiState"}, nil); err != nil {
		return Document{}, err
	}
	var segmentObjects []map[string]json.RawMessage
	if err := json.Unmarshal(top["segments"], &segmentObjects); err != nil {
		return Document{}, errors.New("segments must be an array")
	}
	for _, segment := range segmentObjects {
		if err := exactKeys(segment, []string{"startMs", "endMs"}, []string{"label"}); err != nil {
			return Document{}, fmt.Errorf("invalid segment: %w", err)
		}
	}
	var ui map[string]json.RawMessage
	if err := json.Unmarshal(top["uiState"], &ui); err != nil || exactKeys(ui, []string{"playheadMs", "zoom", "muted"}, nil) != nil {
		return Document{}, errors.New("invalid uiState")
	}
	var document Document
	strict := json.NewDecoder(bytes.NewReader(data))
	strict.DisallowUnknownFields()
	if err := strict.Decode(&document); err != nil {
		return Document{}, fmt.Errorf("decode project JSON: %w", err)
	}
	if err := Validate(document, durationMS); err != nil {
		return Document{}, err
	}
	return document, nil
}

func exactKeys(object map[string]json.RawMessage, required, optional []string) error {
	allowed := make(map[string]bool, len(required)+len(optional))
	for _, key := range required {
		allowed[key] = true
		if _, ok := object[key]; !ok {
			return fmt.Errorf("missing %q", key)
		}
	}
	for _, key := range optional {
		allowed[key] = true
	}
	for key := range object {
		if !allowed[key] {
			return fmt.Errorf("unknown %q", key)
		}
	}
	return nil
}

type Service struct{ store *store.ProjectStore }

func NewService(projectStore *store.ProjectStore) (*Service, error) {
	if projectStore == nil {
		return nil, errors.New("project store is required")
	}
	return &Service{store: projectStore}, nil
}

func (s *Service) Load(ctx context.Context, owner, id string) (Document, error) {
	record, err := s.store.Get(ctx, owner, id)
	if err != nil {
		return Document{}, err
	}
	return decode(record)
}

// Save accepts only the owner-selected revision and returns the incremented one.
func (s *Service) Save(ctx context.Context, owner, id string, document Document, durationMS int64) (Document, error) {
	if err := Validate(document, durationMS); err != nil {
		return Document{}, err
	}
	data, err := json.Marshal(document)
	if err != nil {
		return Document{}, err
	}
	record, err := s.store.Save(ctx, owner, id, document.Revision, string(data))
	if err != nil {
		return Document{}, err
	}
	return decode(record)
}

func decode(record store.ProjectRecord) (Document, error) {
	var document Document
	if err := json.Unmarshal([]byte(record.DocumentJSON), &document); err != nil {
		return Document{}, fmt.Errorf("decode project document: %w", err)
	}
	document.Revision = record.Revision // The database revision is authoritative.
	return document, nil
}
