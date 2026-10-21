package export

import (
	"cmp"
	"slices"
	"videocutlist/internal/projects/model"
)

// ResolveRanges freezes the exact included ranges for an export selection.
func ResolveRanges(segments []model.Segment, selection string, duration int64) []model.Segment {
	included := make([]model.Segment, 0, len(segments))
	for _, segment := range segments {
		if segment.IsIncluded() {
			included = append(included, segment)
		}
	}
	if selection == "segments" {
		return included
	}
	ordered := slices.Clone(included)
	slices.SortFunc(ordered, func(a, b model.Segment) int { return cmp.Compare(a.StartMS, b.StartMS) })
	var gaps []model.Segment
	cursor := int64(0)
	for _, segment := range ordered {
		if cursor < segment.StartMS {
			gaps = append(gaps, model.Segment{StartMS: cursor, EndMS: segment.StartMS})
		}
		if segment.EndMS > cursor {
			cursor = segment.EndMS
		}
	}
	if cursor < duration {
		gaps = append(gaps, model.Segment{StartMS: cursor, EndMS: duration})
	}
	return gaps
}
