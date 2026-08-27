package export

import (
	"testing"
	"videocutlist/infrastructure/media/probe"
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
