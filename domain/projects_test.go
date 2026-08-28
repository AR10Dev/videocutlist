package domain

import (
	"testing"
)

const mediaID = "m_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

func TestValidateAllowsExportOrderIndependentOfTimelineOrder(t *testing.T) {
	document := Document{
		MediaID:  mediaID,
		Segments: []Segment{{StartMS: 600, EndMS: 900}, {StartMS: 0, EndMS: 300}},
		UIState:  UIState{Zoom: 1},
	}
	if err := Validate(document, 1_000); err != nil {
		t.Fatalf("reordered segments rejected: %v", err)
	}
}

func TestValidateProjectRequiresOrderedIndependentItems(t *testing.T) {
	document := Document{SchemaVersion: ProjectSchemaVersion, Name: "Batch", Items: []ProjectItem{
		{ID: "i_aaaaaaaaaaaaaaaaaaaaaaaa", MediaID: mediaID, Segments: []Segment{{StartMS: 0, EndMS: 300}}, EditorState: &UIState{Zoom: 1}},
		{ID: "i_bbbbbbbbbbbbbbbbbbbbbbbb", MediaID: mediaID, Segments: []Segment{{StartMS: 400, EndMS: 700}}, ExportOptions: ExportOptions{Container: "mkv"}},
	}}
	if err := ValidateProject(document); err != nil {
		t.Fatalf("valid repeated-media batch rejected: %v", err)
	}
	document.Items[1].ID = document.Items[0].ID
	if err := ValidateProject(document); err == nil {
		t.Fatal("duplicate item IDs accepted")
	}
}

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
