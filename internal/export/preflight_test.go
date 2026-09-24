package export

import (
	"testing"
	"videocutlist/internal/library/media/probe"
)

func validPreflightRequest(indexes ...int) Request {
	return Request{Mode: "merge", Container: "mkv", CutStrategy: "stream_copy_preferred", StreamIndexes: indexes}
}

func findingCodes(result PreflightResult) map[string]bool {
	codes := make(map[string]bool, len(result.Findings))
	for _, finding := range result.Findings {
		codes[finding.Code] = true
	}
	return codes
}

func TestPreflightDefaultStreamCombinations(t *testing.T) {
	tests := []struct {
		name      string
		streams   []probe.Stream
		selection []int
	}{
		{"video-only", []probe.Stream{{Index: 0, Type: "video"}}, []int{0}},
		{"multi-audio", []probe.Stream{{Index: 0, Type: "video"}, {Index: 1, Type: "audio"}, {Index: 2, Type: "audio"}}, []int{0, 1, 2}},
		{"subtitle", []probe.Stream{{Index: 0, Type: "video"}, {Index: 1, Type: "subtitle"}}, []int{0, 1}},
		{"attachment-and-data-omitted", []probe.Stream{{Index: 0, Type: "video"}, {Index: 1, Type: "attachment"}, {Index: 2, Type: "data"}}, []int{0}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			result := Preflight(validPreflightRequest(), probe.Metadata{Streams: test.streams})
			if !result.Allowed || len(result.Selection) != len(test.selection) {
				t.Fatalf("result=%#v", result)
			}
			for i, index := range test.selection {
				if result.Selection[i] != index {
					t.Fatalf("selection=%v, want %v", result.Selection, test.selection)
				}
			}
			if !findingCodes(result)["default_stream_selection"] {
				t.Fatalf("findings=%#v", result.Findings)
			}
		})
	}
}

func TestPreflightDisclosesProcessingBeforeExecution(t *testing.T) {
	metadata := probe.Metadata{Streams: []probe.Stream{{Index: 0, Type: "video", Codec: "h264"}, {Index: 1, Type: "audio", Codec: "aac"}}}
	for _, test := range []struct {
		strategy string
		code     string
	}{
		{"stream_copy_preferred", "stream_copy_boundaries"},
		{"precise_reencode", "reencode_required"},
		{"hybrid_smart_cut", "hybrid_reencode_required"},
	} {
		result := Preflight(Request{Mode: "merge", Container: "mkv", CutStrategy: test.strategy}, metadata)
		if !result.Allowed || !findingCodes(result)[test.code] {
			t.Fatalf("%s findings = %#v", test.strategy, result.Findings)
		}
	}
}

func TestPreflightMP4MOVCompatibilityAndReencodeFindings(t *testing.T) {
	streams := []probe.Stream{
		{Index: 0, Type: "video", Codec: "h264"},
		{Index: 1, Type: "audio", Codec: "aac", Channels: 2},
		{Index: 2, Type: "subtitle", Codec: "subrip"},
		{Index: 3, Type: "video", Codec: "vp9"},
	}
	metadata := probe.Metadata{Streams: streams}
	for _, container := range []string{"mp4", "mov"} {
		t.Run(container+" copy", func(t *testing.T) {
			result := Preflight(Request{Mode: "merge", Container: container, CutStrategy: "stream_copy_preferred", StreamIndexes: []int{0, 1}}, metadata)
			if !result.Allowed {
				t.Fatalf("compatible streams blocked: %#v", result)
			}
		})
		t.Run(container+" subtitle", func(t *testing.T) {
			result := Preflight(Request{Mode: "merge", Container: container, CutStrategy: "stream_copy_preferred", StreamIndexes: []int{0, 1, 2}}, metadata)
			if result.Allowed || !findingCodes(result)["incompatible_stream"] {
				t.Fatalf("subtitle selection was not blocked: %#v", result)
			}
		})
		t.Run(container+" incompatible codec", func(t *testing.T) {
			result := Preflight(Request{Mode: "merge", Container: container, CutStrategy: "stream_copy_preferred", StreamIndexes: []int{0, 3}}, metadata)
			if result.Allowed || !findingCodes(result)["incompatible_stream"] {
				t.Fatalf("incompatible codec was not blocked: %#v", result)
			}
		})
		t.Run(container+" precise", func(t *testing.T) {
			result := Preflight(Request{Mode: "merge", Container: container, CutStrategy: "precise_reencode", StreamIndexes: []int{0, 1}}, metadata)
			if !result.Allowed || !findingCodes(result)["reencode_required"] {
				t.Fatalf("precise finding/result = %#v", result)
			}
		})
	}
	result := Preflight(Request{Mode: "merge", Container: "mp4", CutStrategy: "stream_copy_preferred"}, metadata)
	if result.Allowed || !findingCodes(result)["incompatible_stream"] {
		t.Fatalf("default subtitle selection was not blocked: %#v", result)
	}
}

func TestPreflightBlocksInvalidExplicitSelections(t *testing.T) {
	tests := []struct {
		name    string
		indexes []int
		streams []probe.Stream
		code    string
	}{
		{"attachment", []int{1}, []probe.Stream{{Index: 1, Type: "attachment"}}, "forbidden_stream_type"},
		{"data", []int{1}, []probe.Stream{{Index: 1, Type: "data"}}, "forbidden_stream_type"},
		{"unknown", []int{9}, []probe.Stream{{Index: 0, Type: "video"}}, "unknown_stream_index"},
		{"duplicate", []int{0, 0}, []probe.Stream{{Index: 0, Type: "video"}}, "duplicate_stream_index"},
		{"no-allowed-streams", nil, []probe.Stream{{Index: 1, Type: "attachment"}}, "no_allowed_streams"},
		{"audio-only-selection", []int{1}, []probe.Stream{{Index: 0, Type: "video"}, {Index: 1, Type: "audio"}}, "no_video_stream"},
		{"subtitle-only-selection", []int{1}, []probe.Stream{{Index: 0, Type: "video"}, {Index: 1, Type: "subtitle"}}, "no_video_stream"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			result := Preflight(validPreflightRequest(test.indexes...), probe.Metadata{Streams: test.streams})
			if result.Allowed || !findingCodes(result)[test.code] {
				t.Fatalf("result=%#v, want blocked %q", result, test.code)
			}
		})
	}
}
