package export

import (
	"reflect"
	"testing"
	"videocutlist/internal/projects/model"
)

func TestResolveRanges(t *testing.T) {
	segments := []model.Segment{
		{StartMS: 400, EndMS: 700},
		{StartMS: 100, EndMS: 500},
		(model.Segment{StartMS: 800, EndMS: 900}).WithIncluded(false),
	}
	original := append([]model.Segment(nil), segments...)
	for _, tc := range []struct {
		name, selection string
		want            []model.Segment
	}{
		{"included in project order", "segments", segments[:2]},
		{"complement merges overlap and ignores excluded", "gaps", []model.Segment{{StartMS: 0, EndMS: 100}, {StartMS: 700, EndMS: 1000}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := ResolveRanges(segments, tc.selection, 1000); !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("ranges = %#v, want %#v", got, tc.want)
			}
		})
	}
	if !reflect.DeepEqual(segments, original) {
		t.Fatal("export changed project segment order")
	}
	if got := ResolveRanges(nil, "gaps", 1000); !reflect.DeepEqual(got, []model.Segment{{StartMS: 0, EndMS: 1000}}) {
		t.Fatalf("empty selection gaps = %#v", got)
	}
}
