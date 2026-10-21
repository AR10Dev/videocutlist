package export

import (
	"slices"
	"videocutlist/internal/projects/model"
)

func segmentStrategies(requested string, segments []model.Segment, keyframes []int64) []AppliedStrategy {
	strategies := make([]AppliedStrategy, len(segments))
	for i, segment := range segments {
		strategy := requested
		if requested == "hybrid_smart_cut" && !hasInteriorKeyframe(segment, keyframes) {
			strategy = "stream_copy"
		}
		strategies[i] = AppliedStrategy{Segment: i + 1, Strategy: strategy}
	}
	return strategies
}

func newResult(container string, destination Destination, service Service, strategies []AppliedStrategy) Result {
	return Result{
		Container:         container,
		RetainUntil:       now(service).Add(destinationRetention(destination, service)),
		DestinationID:     destination.ID,
		DestinationKind:   destination.Kind,
		AppliedStrategy:   uniformStrategy(strategies),
		AppliedStrategies: strategies,
	}
}

func applyResultMetadata(result *Result, requested string, segments []model.Segment, keyframes []int64, hybridInterior bool) {
	result.Verified = requested != "precise_reencode"
	switch {
	case requested == "precise_reencode":
		result.Warnings = []Warning{{Code: "experimental_precise_reencode", Message: "Experimental full re-encode mode; output boundaries and codec behavior require inspection."}}
	case requested == "hybrid_smart_cut":
		result.Warnings = hybridWarnings(segments, keyframes, hybridInterior)
	case hasPotentiallyInexactCut(segments, keyframes):
		result.Warnings = []Warning{{Code: "stream_copy_cut_may_not_be_frame_exact", Message: "Stream-copy cuts can start on an earlier keyframe; requested non-keyframe boundaries are not frame-exact."}}
	}
}

func uniformStrategy(strategies []AppliedStrategy) string {
	if len(strategies) == 0 {
		return ""
	}
	strategy := strategies[0].Strategy
	for _, value := range strategies[1:] {
		if value.Strategy != strategy {
			return ""
		}
	}
	return strategy
}

func hasPotentiallyInexactCut(segments []model.Segment, keyframes []int64) bool {
	for _, segment := range segments {
		if !slices.Contains(keyframes, segment.StartMS) {
			return true
		}
	}
	return false
}
