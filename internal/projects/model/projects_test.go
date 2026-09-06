package model

import (
	"encoding/json"
	"testing"
)

const mediaID = "m_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

func TestValidateProjectAllowsIndependentOrderedItems(t *testing.T) {
	document := Document{SchemaVersion: ProjectSchemaVersion, Name: "Batch", Items: []ProjectItem{
		{ID: "i_aaaaaaaaaaaaaaaaaaaaaaaa", MediaID: mediaID, Segments: []Segment{{StartMS: 600, EndMS: 900}, {StartMS: 0, EndMS: 300}}, EditorState: &UIState{Zoom: 1}},
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

func TestValidateProjectItemRejectsOverlappingAndOutOfRangeSegments(t *testing.T) {
	item := ProjectItem{Segments: []Segment{{StartMS: 0, EndMS: 500}, {StartMS: 400, EndMS: 1_200}}}
	if err := ValidateProjectItem(item, 1_000); err == nil {
		t.Fatal("overlapping and out-of-range segments were accepted")
	}
}

func TestSegmentMetadataDefaultsAndRoundTrips(t *testing.T) {
	var legacy Segment
	if err := json.Unmarshal([]byte(`{"startMs":100,"endMs":300}`), &legacy); err != nil {
		t.Fatal(err)
	}
	if !legacy.IsIncluded() || legacy.Included != true {
		t.Fatalf("legacy segment inclusion = %#v", legacy)
	}
	var excluded Segment
	if err := json.Unmarshal([]byte(`{"id":"s_custom","startMs":100,"endMs":300,"included":false}`), &excluded); err != nil {
		t.Fatal(err)
	}
	if excluded.IsIncluded() || excluded.ID != "s_custom" {
		t.Fatalf("excluded segment metadata = %#v", excluded)
	}
	encoded, err := json.Marshal(excluded)
	if err != nil {
		t.Fatal(err)
	}
	var roundTrip Segment
	if err := json.Unmarshal(encoded, &roundTrip); err != nil {
		t.Fatal(err)
	}
	if roundTrip.ID != excluded.ID || roundTrip.StartMS != excluded.StartMS || roundTrip.EndMS != excluded.EndMS || roundTrip.Included {
		t.Fatalf("round trip = %#v", roundTrip)
	}
}

func TestValidateProjectEnsuresStableLegacySegmentIDs(t *testing.T) {
	document := Document{SchemaVersion: ProjectSchemaVersion, Name: "Legacy", Items: []ProjectItem{{
		ID: mediaItemID("a"), MediaID: mediaID, Segments: []Segment{{StartMS: 0, EndMS: 100}, {StartMS: 200, EndMS: 300}},
	}}}
	if err := ValidateProject(document); err != nil {
		t.Fatal(err)
	}
	first := document.Items[0].Segments[0].ID
	second := document.Items[0].Segments[1].ID
	if first == "" || second == "" || first == second {
		t.Fatalf("legacy IDs = %q, %q", first, second)
	}
	EnsureSegmentIDs(&document)
	if document.Items[0].Segments[0].ID != first || document.Items[0].Segments[1].ID != second {
		t.Fatal("legacy IDs were not stable")
	}
}

func mediaItemID(suffix string) string {
	return "i_" + "aaaaaaaaaaaaaaaaaaaaaaa" + suffix
}
