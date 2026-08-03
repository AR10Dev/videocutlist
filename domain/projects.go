package domain

import (
	"errors"
	"fmt"
	"math"
	"regexp"
	"unicode/utf8"
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
