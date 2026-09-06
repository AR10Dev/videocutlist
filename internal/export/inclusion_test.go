package export

import (
	"encoding/json"
	"testing"

	"videocutlist/internal/projects/model"
)

func TestSelectedSegmentsOmitExplicitlyExcludedRanges(t *testing.T) {
	var excluded model.Segment
	if err := json.Unmarshal([]byte(`{"id":"s_excluded","startMs":500,"endMs":700,"included":false}`), &excluded); err != nil {
		t.Fatal(err)
	}
	segments := []model.Segment{{ID: "s_kept", StartMS: 100, EndMS: 300, Included: true}, excluded}
	got := selectedSegments(segments, "segments", 1_000)
	if len(got) != 1 || got[0].ID != "s_kept" {
		t.Fatalf("selected segments = %#v", got)
	}
	gaps := selectedSegments(segments, "gaps", 1_000)
	want := []model.Segment{{StartMS: 0, EndMS: 100}, {StartMS: 300, EndMS: 1_000}}
	if len(gaps) != len(want) || gaps[0].StartMS != want[0].StartMS || gaps[0].EndMS != want[0].EndMS || gaps[1].StartMS != want[1].StartMS {
		t.Fatalf("gaps = %#v", gaps)
	}
}
