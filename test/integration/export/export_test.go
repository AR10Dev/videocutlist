package export_test

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"videocutlist/internal/export"
	"videocutlist/internal/library/media/probe"
	"videocutlist/internal/projects/model"
)

func TestGeneratedStreamCombinationFixtures(t *testing.T) {
	ffprobe, err := exec.LookPath("ffprobe")
	if err != nil {
		t.Skip("ffprobe is required")
	}
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("ffmpeg is required")
	}
	root, err := filepath.Abs(filepath.Join("..", "..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	fixtures := filepath.Join(t.TempDir(), "fixtures")
	command := exec.Command(filepath.Join(root, "test", "harness", "generate-fixtures.sh"), fixtures)
	command.Env = append(os.Environ(), "FFMPEG_BIN="+ffmpeg, "FFPROBE_BIN="+ffprobe)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("cannot generate fixtures: %v: %s", err, output)
	}
	for _, test := range []struct {
		name                   string
		video, audio, subtitle int
	}{
		{"avc-video-only-long-gop.mp4", 1, 0, 0},
		{"multi-audio-avc-aac.mkv", 1, 2, 0},
		{"subtitle-avc-aac.mkv", 1, 1, 1},
	} {
		metadata, err := (probe.Client{Path: ffprobe}).Probe(context.Background(), filepath.Join(fixtures, test.name))
		if err != nil || metadata.DurationMS <= 0 || metadata.VideoStreams != test.video || metadata.AudioStreams != test.audio {
			t.Fatalf("fixture %s: metadata=%#v, err=%v", test.name, metadata, err)
		}
		subtitles := 0
		for _, stream := range metadata.Streams {
			if stream.Type == "subtitle" {
				subtitles++
			}
		}
		if subtitles != test.subtitle {
			t.Fatalf("fixture %s: subtitle streams=%d, want %d", test.name, subtitles, test.subtitle)
		}
	}
	source, err := (probe.Client{Path: ffprobe}).Probe(context.Background(), filepath.Join(fixtures, "avc-aac.mkv"))
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"corrupt-truncated.mp4", "attachment-avc-aac.mkv"} {
		if err := export.VerifyOutput(context.Background(), ffprobe, filepath.Join(fixtures, name), source, []int{0}); err == nil {
			t.Fatalf("invalid fixture %s was accepted by output verification", name)
		}
	}
}

func projectDocument(segments ...model.Segment) model.Document {
	return model.Document{Items: []model.ProjectItem{{Segments: segments}}}
}

func TestStreamCopySegmentsMergeWithWarningAndAtomicPublish(t *testing.T) {
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("ffmpeg is required for export integration test")
	}
	if _, err := exec.LookPath("ffprobe"); err != nil {
		t.Skip("ffprobe is required for export integration test")
	}
	directory := t.TempDir()
	sourcePath := filepath.Join(directory, "fixture.mp4")
	fixture := exec.Command(ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30", "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000", "-t", "2", "-map", "0:v:0", "-map", "1:a:0", "-c:v", "libx264", "-g", "60", "-pix_fmt", "yuv420p", "-c:a", "aac", sourcePath)
	if output, err := fixture.CombinedOutput(); err != nil {
		t.Skipf("cannot generate libx264 fixture: %v: %s", err, output)
	}
	source, err := os.Open(sourcePath)
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	if err := os.Remove(sourcePath); err != nil {
		t.Fatal(err)
	}
	outputDir := filepath.Join(directory, "exports")
	service := export.Service{FFmpegPath: ffmpeg, OutputDir: outputDir, Retention: time.Hour}
	document := projectDocument(model.Segment{StartMS: 0, EndMS: 700}, model.Segment{StartMS: 1_000, EndMS: 1_700})
	result, err := service.Run(context.Background(), source, document, export.Request{Mode: "merge", CutStrategy: "stream_copy_preferred", Container: "mkv"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(result.OutputName, ".mkv") || len(result.Warnings) != 1 {
		t.Fatalf("result = %#v", result)
	}
	outputPath := filepath.Join(outputDir, result.OutputName)
	if _, err := (probe.Client{}).Probe(context.Background(), outputPath); err != nil {
		t.Fatalf("published output does not probe: %v", err)
	}
	entries, err := os.ReadDir(outputDir)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.Contains(entry.Name(), ".export-") || strings.Contains(entry.Name(), ".partial") {
			t.Fatalf("incomplete export left behind: %s", entry.Name())
		}
	}
}

func TestHybridSmartCutMKVFixtureAndFallback(t *testing.T) {
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("ffmpeg is required")
	}
	if _, err := exec.LookPath("ffprobe"); err != nil {
		t.Skip("ffprobe is required")
	}
	directory := t.TempDir()
	sourcePath := filepath.Join(directory, "fixture.mkv")
	fixture := exec.Command(ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30", "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000", "-t", "2", "-map", "0:v:0", "-map", "1:a:0", "-c:v", "libx264", "-g", "15", "-pix_fmt", "yuv420p", "-c:a", "libopus", sourcePath)
	if output, err := fixture.CombinedOutput(); err != nil {
		t.Skipf("cannot generate fixture: %v: %s", err, output)
	}
	source, err := os.Open(sourcePath)
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	service := export.Service{FFmpegPath: ffmpeg, OutputDir: filepath.Join(directory, "exports")}
	document := projectDocument(model.Segment{StartMS: 100, EndMS: 900})
	result, err := service.Run(context.Background(), source, document, export.Request{Mode: "merge", CutStrategy: "hybrid_smart_cut", Container: "mkv"})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Warnings) != 1 || result.Warnings[0].Code != "experimental_hybrid_smart_cut" {
		t.Fatalf("result = %#v", result)
	}
	if _, err := (probe.Client{}).Probe(context.Background(), filepath.Join(service.OutputDir, result.OutputName)); err != nil {
		t.Fatalf("hybrid output does not probe: %v", err)
	}
}

func TestExportStrategiesReportTruthfulBoundaryWarnings(t *testing.T) {
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("ffmpeg is required")
	}
	if _, err := exec.LookPath("ffprobe"); err != nil {
		t.Skip("ffprobe is required")
	}
	directory := t.TempDir()
	sourcePath := filepath.Join(directory, "keyframe-layout.mkv")
	fixture := exec.Command(ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30", "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000", "-t", "2", "-map", "0:v:0", "-map", "1:a:0", "-c:v", "libx264", "-g", "15", "-pix_fmt", "yuv420p", "-c:a", "libopus", sourcePath)
	if output, err := fixture.CombinedOutput(); err != nil {
		t.Skipf("cannot generate fixture: %v: %s", err, output)
	}
	source, err := os.Open(sourcePath)
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	service := export.Service{FFmpegPath: ffmpeg, OutputDir: filepath.Join(directory, "exports")}
	keyframes, err := (probe.Client{}).Keyframes(context.Background(), source)
	if err != nil || !containsKeyframes(keyframes, 0, 500, 1000) {
		t.Fatalf("fixture keyframes = %v, err = %v", keyframes, err)
	}

	tests := []struct {
		name       string
		start, end int64
		strategy   string
		used       string
		code       string
		message    string
		verified   bool
		warnings   int
	}{
		{"aligned stream copy", 0, 1000, "stream_copy_preferred", "stream_copy_preferred", "", "", true, 0},
		{"sparse stream copy", 100, 400, "stream_copy_preferred", "stream_copy_preferred", "stream_copy_cut_may_not_be_frame_exact", "Stream-copy cuts can start on an earlier keyframe; requested non-keyframe boundaries are not frame-exact.", true, 1},
		{"aligned precise re-encode", 0, 1000, "precise_reencode", "precise_reencode", "experimental_precise_reencode", "Experimental full re-encode mode; output boundaries and codec behavior require inspection.", false, 1},
		{"sparse precise re-encode", 100, 400, "precise_reencode", "precise_reencode", "experimental_precise_reencode", "Experimental full re-encode mode; output boundaries and codec behavior require inspection.", false, 1},
		{"aligned hybrid smart cut", 0, 1000, "hybrid_smart_cut", "hybrid_smart_cut", "experimental_hybrid_smart_cut", "Experimental H.264 CFR MKV hybrid cut; the leading video boundary is re-encoded, the remaining video span is stream-copied, and audio is consistently AAC-encoded. Output is not frame-exact without probe confirmation.", true, 1},
		{"sparse hybrid smart cut", 100, 400, "hybrid_smart_cut", "stream_copy", "hybrid_smart_cut_stream_copy_fallback", "Segment 1 had no compatible interior keyframe; the requested span was stream-copied and may not be frame-exact.", true, 1},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			result, err := service.Run(context.Background(), source, projectDocument(model.Segment{StartMS: test.start, EndMS: test.end}), export.Request{Mode: "merge", CutStrategy: test.strategy, Container: "mkv"})
			if err != nil {
				t.Fatal(err)
			}
			if result.AppliedStrategy != test.used || result.Verified != test.verified {
				t.Fatalf("result = %#v, want strategy %q and verified %v", result, test.used, test.verified)
			}
			assertPublicOutputNames(t, result, sourcePath)
			if len(result.Warnings) != test.warnings {
				t.Fatalf("warnings = %#v", result.Warnings)
			}
			if test.code != "" && (result.Warnings[0].Code != test.code || result.Warnings[0].Message != test.message) {
				t.Fatalf("warning = %#v, want code %q and message %q", result.Warnings[0], test.code, test.message)
			}
			if _, err := (probe.Client{}).Probe(context.Background(), filepath.Join(service.OutputDir, result.OutputName)); err != nil {
				t.Fatalf("output does not probe: %v", err)
			}
		})
	}

	result, err := service.Run(context.Background(), source, projectDocument(model.Segment{StartMS: 0, EndMS: 1000}, model.Segment{StartMS: 100, EndMS: 400}), export.Request{Mode: "separate", CutStrategy: "stream_copy_preferred", Container: "mkv"})
	if err != nil {
		t.Fatal(err)
	}
	assertPublicOutputNames(t, result, sourcePath)
}

func TestSeparateHybridExportReportsEachSegmentStrategy(t *testing.T) {
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("ffmpeg is required")
	}
	if _, err := exec.LookPath("ffprobe"); err != nil {
		t.Skip("ffprobe is required")
	}
	directory := t.TempDir()
	sourcePath := filepath.Join(directory, "keyframe-layout.mkv")
	fixture := exec.Command(ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30", "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000", "-t", "2", "-map", "0:v:0", "-map", "1:a:0", "-c:v", "libx264", "-g", "15", "-pix_fmt", "yuv420p", "-c:a", "libopus", sourcePath)
	if output, err := fixture.CombinedOutput(); err != nil {
		t.Skipf("cannot generate fixture: %v: %s", err, output)
	}
	source, err := os.Open(sourcePath)
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()

	result, err := (export.Service{FFmpegPath: ffmpeg, OutputDir: filepath.Join(directory, "exports")}).Run(context.Background(), source, projectDocument(model.Segment{StartMS: 0, EndMS: 1000}, model.Segment{StartMS: 100, EndMS: 400}), export.Request{Mode: "separate", CutStrategy: "hybrid_smart_cut", Container: "mkv"})
	if err != nil {
		t.Fatal(err)
	}
	if result.AppliedStrategy != "" || len(result.AppliedStrategies) != 2 || result.AppliedStrategies[0].Segment != 1 || result.AppliedStrategies[0].Strategy != "hybrid_smart_cut" || result.AppliedStrategies[0].OutputName != result.OutputNames[0] || result.AppliedStrategies[1].Segment != 2 || result.AppliedStrategies[1].Strategy != "stream_copy" || result.AppliedStrategies[1].OutputName != result.OutputNames[1] {
		t.Fatalf("result = %#v", result)
	}
	if len(result.Warnings) != 2 || result.Warnings[1].Code != "hybrid_smart_cut_stream_copy_fallback" || !strings.Contains(result.Warnings[1].Message, "Segment 2") {
		t.Fatalf("warnings = %#v", result.Warnings)
	}
	assertPublicOutputNames(t, result, sourcePath)
}

func containsKeyframes(keyframes []int64, wanted ...int64) bool {
	for _, timestamp := range wanted {
		if !slices.Contains(keyframes, timestamp) {
			return false
		}
	}
	return true
}

func assertPublicOutputNames(t *testing.T, result export.Result, sourcePath string) {
	t.Helper()
	names := append(append([]string(nil), result.OutputNames...), result.OutputName)
	for _, strategy := range result.AppliedStrategies {
		names = append(names, strategy.OutputName)
	}
	for _, name := range names {
		if name != "" && (strings.ContainsAny(name, `/\\`) || strings.Contains(name, sourcePath) || strings.Contains(name, ".videocutlist-export-")) {
			t.Fatalf("result exposed a filesystem path or temporary name: %#v", result)
		}
	}
	encoded, err := json.Marshal(result)
	if err != nil || strings.Contains(string(encoded), filepath.Dir(sourcePath)) {
		t.Fatalf("result exposed an internal path: %s, err = %v", encoded, err)
	}
}

func TestHybridSmartCutRejectsWebMAndInvalidRate(t *testing.T) {
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("ffmpeg is required")
	}
	directory := t.TempDir()
	webm := filepath.Join(directory, "fixture.webm")
	cmd := exec.Command(ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=30", "-t", "1", "-c:v", "libvpx-vp9", webm)
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Skipf("cannot generate WebM fixture: %v: %s", err, output)
	}
	source, err := os.Open(webm)
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	service := export.Service{FFmpegPath: ffmpeg, OutputDir: filepath.Join(directory, "exports")}
	_, err = service.Run(context.Background(), source, projectDocument(model.Segment{StartMS: 0, EndMS: 500}), export.Request{Mode: "merge", CutStrategy: "hybrid_smart_cut", Container: "mkv"})
	if !errors.Is(err, export.ErrInvalidRequest) {
		t.Fatalf("WebM error = %v", err)
	}
	vfr := filepath.Join(directory, "fixture-vfr.mkv")
	cmd = exec.Command(ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=30", "-t", "1", "-vf", "select='if(lt(n,15),not(mod(n,3)),not(mod(n,2)))'", "-fps_mode", "vfr", "-c:v", "libx264", vfr)
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Skipf("cannot generate VFR fixture: %v: %s", err, output)
	}
	vfrSource, err := os.Open(vfr)
	if err != nil {
		t.Fatal(err)
	}
	defer vfrSource.Close()
	_, err = service.Run(context.Background(), vfrSource, projectDocument(model.Segment{StartMS: 0, EndMS: 500}), export.Request{Mode: "merge", CutStrategy: "hybrid_smart_cut", Container: "mkv"})
	if !errors.Is(err, export.ErrInvalidRequest) {
		t.Fatalf("VFR error = %v", err)
	}
}

func TestCancellationRemovesIncompleteOutput(t *testing.T) {
	directory := t.TempDir()
	sourcePath := filepath.Join(directory, "source")
	if err := os.WriteFile(sourcePath, []byte("source"), 0o600); err != nil {
		t.Fatal(err)
	}
	source, err := os.Open(sourcePath)
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	ffmpeg := filepath.Join(directory, "wait-for-cancel.sh")
	if err := os.WriteFile(ffmpeg, []byte("#!/bin/sh\nexec sleep 10\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	ffprobe := filepath.Join(directory, "wait-for-probe-cancel.sh")
	if err := os.WriteFile(ffprobe, []byte("#!/bin/sh\nexec sleep 10\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(directory, "exports"), 0o750); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	service := export.Service{FFmpegPath: ffmpeg, FFprobePath: ffprobe, OutputDir: filepath.Join(directory, "exports")}
	_, err = service.Run(ctx, source, projectDocument(model.Segment{StartMS: 0, EndMS: 1}), export.Request{Mode: "merge", CutStrategy: "stream_copy_preferred", Container: "mkv"})
	if !errors.Is(err, export.ErrCancelled) {
		t.Fatalf("cancellation error = %v", err)
	}
	entries, err := os.ReadDir(filepath.Join(directory, "exports"))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("cancelled export published leftovers: %#v", entries)
	}
}
