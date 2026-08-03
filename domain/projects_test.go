package domain

import (
	"testing"
)

const mediaID = "m_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

func TestValidateRejectsOverlappingAndOutOfRangeSegments(t *testing.T) {
	document := Document{
		MediaID:  mediaID,
		Segments: []Segment{{StartMS: 0, EndMS: 500}, {StartMS: 400, EndMS: 1_200}},
		UIState:  UIState{Zoom: 1},
	}
	if err := Validate(document, 1_000); err == nil {
		t.Fatal("overlapping and out-of-range segments were accepted")
	}
}
