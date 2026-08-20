package export_test

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"videocutlist/domain"
	"videocutlist/infrastructure/export"
	"videocutlist/infrastructure/media/probe"
)

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
	document := domain.Document{Segments: []domain.Segment{{StartMS: 0, EndMS: 700}, {StartMS: 1_000, EndMS: 1_700}}}
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
	document := domain.Document{Segments: []domain.Segment{{StartMS: 100, EndMS: 900}}}
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
	_, err = service.Run(context.Background(), source, domain.Document{Segments: []domain.Segment{{StartMS: 0, EndMS: 500}}}, export.Request{Mode: "merge", CutStrategy: "hybrid_smart_cut", Container: "mkv"})
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
	_, err = service.Run(context.Background(), vfrSource, domain.Document{Segments: []domain.Segment{{StartMS: 0, EndMS: 500}}}, export.Request{Mode: "merge", CutStrategy: "hybrid_smart_cut", Container: "mkv"})
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
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	service := export.Service{FFmpegPath: ffmpeg, OutputDir: filepath.Join(directory, "exports")}
	_, err = service.Run(ctx, source, domain.Document{Segments: []domain.Segment{{StartMS: 0, EndMS: 1}}}, export.Request{Mode: "merge", CutStrategy: "stream_copy_preferred", Container: "mkv"})
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
