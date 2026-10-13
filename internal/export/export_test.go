package export

import (
	"context"
	"encoding/json"
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

// The subprocesses keep the publication test focused on failures after a
// verified first segment, without depending on a platform codec installation.
func separateExportFixture(t *testing.T, failure string) (Service, *os.File, model.Document, Request, string) {
	t.Helper()
	dir := t.TempDir()
	outputDir := filepath.Join(dir, "outputs")
	if err := os.Mkdir(outputDir, 0o700); err != nil {
		t.Fatal(err)
	}
	source, err := os.CreateTemp(dir, "source-*.mkv")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = source.Close() })
	if _, err := source.WriteString("media"); err != nil {
		t.Fatal(err)
	}
	t.Setenv("VCL_EXPORT_TEST_DIR", outputDir)
	t.Setenv("VCL_EXPORT_TEST_COUNT", filepath.Join(dir, "probe-count"))
	t.Setenv("VCL_EXPORT_TEST_FAILURE", failure)
	t.Setenv("VCL_EXPORT_TEST_JOB", "j_partialfailure")
	ffprobe := filepath.Join(dir, "ffprobe")
	probeScript := `#!/bin/sh
for arg do
  if [ "$arg" = "-show_frames" ]; then
    printf '0.000000\n2.000000\n'
    exit
  fi
done
count=0
if [ -f "$VCL_EXPORT_TEST_COUNT" ]; then
  count=$(cat "$VCL_EXPORT_TEST_COUNT")
fi
count=$((count + 1))
printf '%s' "$count" > "$VCL_EXPORT_TEST_COUNT"
if [ "$count" -eq 3 ]; then
  case "$VCL_EXPORT_TEST_FAILURE" in
    publish) rm "$VCL_EXPORT_TEST_DIR"/.videocutlist-segments-*/segment-001.mkv ;;
    manifest)
      rm "$VCL_EXPORT_TEST_DIR/.videocutlist-export-$VCL_EXPORT_TEST_JOB.json"
      mkdir "$VCL_EXPORT_TEST_DIR/.videocutlist-export-$VCL_EXPORT_TEST_JOB.json"
      ;;
  esac
fi
duration=2
if [ "$count" -eq 1 ]; then duration=4; fi
printf '{"format":{"duration":"%s","format_name":"matroska"},"streams":[{"index":0,"codec_type":"video","codec_name":"h264"}]}\n' "$duration"
`
	ffmpeg := filepath.Join(dir, "ffmpeg")
	encodeScript := `#!/bin/sh
if [ "$2" = "-muxers" ]; then printf ' E matroska\n'; exit; fi
for arg do output="$arg"; done
printf fixture > "$output"
`
	for path, script := range map[string]string{ffprobe: probeScript, ffmpeg: encodeScript} {
		if err := os.WriteFile(path, []byte(script), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	service := Service{FFprobePath: ffprobe, FFmpegPath: ffmpeg, OutputDir: outputDir, Artifacts: NewArtifactStore()}
	document := model.Document{Items: []model.ProjectItem{{Segments: []model.Segment{{StartMS: 0, EndMS: 2000}, {StartMS: 2000, EndMS: 4000}}}}}
	request := Request{Mode: "separate", CutStrategy: "stream_copy_preferred", Container: "mkv", JobID: "j_partialfailure"}
	return service, source, document, request, outputDir
}

func TestExportRejectsExpandedFilenameOver255Bytes(t *testing.T) {
	for _, test := range []struct {
		name       string
		sourceName string
	}{
		{name: "ASCII", sourceName: strings.Repeat("x", 240) + ".mkv"},
		{name: "multibyte", sourceName: strings.Repeat("é", 117) + ".mkv"},
	} {
		t.Run(test.name, func(t *testing.T) {
			service, source, document, request, outputDir := separateExportFixture(t, "")
			request.Mode = "merge"
			request.FilenameTemplate = "{source}.{ext}"
			request.SourceName = test.sourceName

			result, err := service.Run(t.Context(), source, document, request)
			if !errors.Is(err, ErrInvalidRequest) || !strings.Contains(err.Error(), "255 bytes") {
				t.Fatalf("export error = %v, want explicit invalid request for a filename over 255 bytes", err)
			}
			if result.OutputName != "" || len(result.OutputNames) != 0 {
				t.Fatalf("rejected export returned output names: %+v", result)
			}
			entries, err := os.ReadDir(outputDir)
			if err != nil {
				t.Fatal(err)
			}
			if len(entries) != 0 {
				t.Fatalf("rejected export created destination files: %v", entries)
			}
		})
	}
}

func TestExportKeeps255ByteMultibyteFilenameAndExtension(t *testing.T) {
	service, source, document, request, outputDir := separateExportFixture(t, "")
	request.Mode = "merge"
	request.FilenameTemplate = "{source}.{ext}"
	stem := strings.Repeat("é", 116)
	request.SourceName = stem + ".mkv"
	document.Items[0].Segments = []model.Segment{{StartMS: 0, EndMS: 2000}}

	result, err := service.Run(t.Context(), source, document, request)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.OutputName) != 255 || !strings.HasPrefix(result.OutputName, stem+"-") || filepath.Ext(result.OutputName) != ".mkv" {
		t.Fatalf("output name = %q (%d bytes), want the full source stem, suffix, and .mkv at 255 bytes", result.OutputName, len(result.OutputName))
	}
	info, err := os.Stat(filepath.Join(outputDir, result.OutputName))
	if err != nil {
		t.Fatalf("allocated output was not published: %v", err)
	}
	if !info.Mode().IsRegular() {
		t.Fatalf("published output mode = %s, want regular file", info.Mode())
	}
}

type rejectingLimiter struct{}

func (rejectingLimiter) AcquireProcess() (func(), error) {
	return nil, errors.New("capacity exhausted")
}

func TestExportHonorsSharedFFmpegCapacity(t *testing.T) {
	file, err := os.CreateTemp(t.TempDir(), "source")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := file.Close(); err != nil {
			t.Errorf("close source: %v", err)
		}
	})
	_, err = (Service{Capacity: rejectingLimiter{}}).Run(context.Background(), file, model.Document{}, Request{})
	if err == nil || err.Error() != "capacity exhausted" {
		t.Fatalf("error = %v", err)
	}
}

func TestSelectedSegmentsReturnsTimelineGaps(t *testing.T) {
	got := ResolveRanges([]model.Segment{{StartMS: 600, EndMS: 800}, {StartMS: 100, EndMS: 300}}, "gaps", 1_000)
	want := []model.Segment{{StartMS: 0, EndMS: 100}, {StartMS: 300, EndMS: 600}, {StartMS: 800, EndMS: 1_000}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("gaps = %#v, want %#v", got, want)
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
	warnings := hybridWarnings(segments, []int64{0, 450, 1000}, true)
	if len(warnings) != 3 || warnings[0].Code != "experimental_hybrid_smart_cut" {
		t.Fatalf("warnings = %#v", warnings)
	}
	for i, segment := range []int{1, 2} {
		warning := warnings[i+1]
		if warning.Code != "hybrid_smart_cut_stream_copy_fallback" || !strings.Contains(warning.Message, fmt.Sprintf("Segment %d", segment)) {
			t.Errorf("fallback warning %d = %#v", segment, warning)
		}
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

func TestSeparateExportPartialPublishRetainsOnlySuccessfulManifestEntries(t *testing.T) {
	service, source, document, request, outputDir := separateExportFixture(t, "publish")
	result, err := service.Run(t.Context(), source, document, request)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.OutputNames) != 1 || len(result.OutputFailures) != 1 || result.OutputFailures[0].Code != "output_publish_failed" {
		t.Fatalf("partial publication = %+v", result)
	}
	manifest, err := os.ReadFile(filepath.Join(outputDir, ".videocutlist-export-"+request.JobID+".json"))
	if err != nil {
		t.Fatal(err)
	}
	var published artifactManifest
	if err := json.Unmarshal(manifest, &published); err != nil {
		t.Fatal(err)
	}
	if len(published.OutputNames) != 1 || published.OutputNames[0] != result.OutputNames[0] || len(published.OutputOwners) != 1 {
		t.Fatalf("manifest did not reflect successful outputs: %+v", published)
	}
}

func TestSeparateExportFailureAfterPublicationRollsBackManifest(t *testing.T) {
	service, source, document, request, outputDir := separateExportFixture(t, "manifest")
	_, err := service.Run(t.Context(), source, document, request)
	if err == nil {
		t.Fatal("later manifest rewrite failure was accepted")
	}
	if service.Artifacts.manifests[request.JobID] != "" {
		t.Fatalf("failed export left registered manifest: %q", service.Artifacts.manifests[request.JobID])
	}
	entries, err := os.ReadDir(outputDir)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".mkv") || entry.Name() == ".videocutlist-export-"+request.JobID+".json" && !entry.IsDir() {
			t.Fatalf("failed export left published artifact: %s", entry.Name())
		}
	}
}
