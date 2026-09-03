package export

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"videocutlist/internal/library/media/probe"
	"videocutlist/internal/projects/model"
)

type rejectingLimiter struct{}

func (rejectingLimiter) AcquireProcess() (func(), error) {
	return nil, errors.New("capacity exhausted")
}

func TestPublishNoReplacePreservesExistingOutput(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "temporary.mkv")
	destination := filepath.Join(dir, "published.mkv")
	if err := os.WriteFile(source, []byte("new"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(destination, []byte("existing"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := publishNoReplace(source, destination); !errors.Is(err, os.ErrExist) {
		t.Fatalf("publish error = %v", err)
	}
	data, err := os.ReadFile(destination)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "existing" {
		t.Fatalf("destination = %q", data)
	}
}

func TestExportHonorsSharedFFmpegCapacity(t *testing.T) {
	file, err := os.CreateTemp(t.TempDir(), "source")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	_, err = (Service{Capacity: rejectingLimiter{}}).Run(context.Background(), file, model.Document{}, Request{})
	if err == nil || err.Error() != "capacity exhausted" {
		t.Fatalf("error = %v", err)
	}
}

func TestSelectedSegmentsReturnsTimelineGaps(t *testing.T) {
	got := selectedSegments([]model.Segment{{StartMS: 600, EndMS: 800}, {StartMS: 100, EndMS: 300}}, "gaps", 1_000)
	want := []model.Segment{{StartMS: 0, EndMS: 100}, {StartMS: 300, EndMS: 600}, {StartMS: 800, EndMS: 1_000}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("gaps = %#v, want %#v", got, want)
	}
}

func TestHybridUnsupportedMediaErrorPreservesWrapping(t *testing.T) {
	err := fmt.Errorf("probe: %w: detail", ErrHybridSmartCutUnsupportedMedia)
	if !errors.Is(err, ErrHybridSmartCutUnsupportedMedia) {
		t.Fatalf("error = %v", err)
	}
}

func TestHybridSupportedOnlyAcceptsH264CFRMatroska(t *testing.T) {
	metadata := probe.Metadata{Container: "matroska,webm", Video: &probe.Video{Codec: "h264", AvgFrameRate: "30/1", FrameRate: "30/1"}}
	if !hybridSupported(metadata) {
		t.Fatal("expected H.264 CFR MKV support")
	}
	metadata.Video.Codec = "hevc"
	if hybridSupported(metadata) {
		t.Fatal("accepted H.265")
	}
}

func TestHybridWarningsIdentifyEachFallbackSegment(t *testing.T) {
	segments := []model.Segment{{StartMS: 100, EndMS: 400}, {StartMS: 500, EndMS: 900}}
	warnings := hybridWarnings(segments, []int64{0, 600, 1000}, true)
	if len(warnings) != 2 || warnings[1].Code != "hybrid_smart_cut_stream_copy_fallback" || !strings.Contains(warnings[1].Message, "Segment 1") {
		t.Fatalf("warnings = %#v", warnings)
	}
}

func TestHybridRejectsWebMCodecAndInvalidRate(t *testing.T) {
	metadata := probe.Metadata{Container: "matroska,webm", Video: &probe.Video{Codec: "vp9", AvgFrameRate: "30/1", FrameRate: "30/1"}}
	if hybridSupported(metadata) {
		t.Fatal("accepted WebM VP9")
	}
	metadata.Video.Codec = "h264"
	metadata.Video.FrameRate = "0/0"
	if hybridSupported(metadata) {
		t.Fatal("accepted invalid frame rate")
	}
}

func TestHybridArgsHonorsStreamIndexes(t *testing.T) {
	args := hybridArgs("/proc/self/fd/3", 100, 200, []int{0, 2}, "copy", "aac", "out.mkv")
	joined := strings.Join(args, " ")
	if !strings.Contains(joined, "-map 0:0") || !strings.Contains(joined, "-map 0:2") {
		t.Fatalf("args = %#v", args)
	}
}

func TestHybridInteriorKeyframeAndFallback(t *testing.T) {
	segment := model.Segment{StartMS: 100, EndMS: 900}
	if !hasInteriorKeyframe(segment, []int64{0, 500, 1000}) {
		t.Fatal("missed interior keyframe")
	}
	if hasInteriorKeyframe(segment, []int64{0, 1000}) {
		t.Fatal("treated boundary-less span as hybrid")
	}
	if got := hybridWarningCode(false); got != "hybrid_smart_cut_stream_copy_fallback" {
		t.Fatalf("fallback code = %q", got)
	}
}

func TestValidateStreamIndexesRejectsUnknownAndDuplicateIndexes(t *testing.T) {
	streams := []probe.Stream{{Index: 0}, {Index: 2}}
	if err := validateStreamIndexes([]int{2, 0}, streams); err != nil {
		t.Fatalf("known indexes rejected: %v", err)
	}
	if err := validateStreamIndexes([]int{1}, streams); err == nil {
		t.Fatal("unknown index accepted")
	}
	if err := validateStreamIndexes([]int{0, 0}, streams); err == nil {
		t.Fatal("duplicate index accepted")
	}
}
