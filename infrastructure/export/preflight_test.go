package export

import (
	"testing"
	"videocutlist/infrastructure/media/probe"
)

func TestPreflightDefaultsSafeStreamsAndBlocksForbidden(t *testing.T) {
	result := Preflight(Request{Mode: "merge", Container: "mkv", CutStrategy: "stream_copy_preferred"}, probe.Metadata{Streams: []probe.Stream{{Index: 0, Type: "video"}, {Index: 1, Type: "audio"}, {Index: 2, Type: "subtitle"}, {Index: 3, Type: "attachment"}}})
	if !result.Allowed || len(result.Selection) != 3 || result.Selection[2] != 2 {
		t.Fatalf("result=%#v", result)
	}
	blocked := Preflight(Request{Mode: "merge", Container: "mkv", CutStrategy: "stream_copy_preferred", StreamIndexes: []int{3}}, probe.Metadata{Streams: []probe.Stream{{Index: 3, Type: "attachment"}}})
	if blocked.Allowed {
		t.Fatal("forbidden stream allowed")
	}
}
