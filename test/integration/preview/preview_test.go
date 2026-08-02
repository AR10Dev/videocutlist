package preview_test

import (
	"context"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"editapp/internal/contracts"
	ffmpegrunner "editapp/internal/ffmpeg"
)

func TestSoftwarePreviewStreamsAndValidates(t *testing.T) {
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("ffmpeg unavailable")
	}
	ffprobe, err := exec.LookPath("ffprobe")
	if err != nil {
		t.Skip("ffprobe unavailable")
	}
	dir := t.TempDir()
	sourceName := filepath.Join(dir, "source.mp4")
	if output, err := exec.Command(ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=30", "-f", "lavfi", "-i", "sine=frequency=1000:sample_rate=48000", "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", sourceName).CombinedOutput(); err != nil {
		t.Fatalf("generate fixture: %v: %s", err, output)
	}
	source, err := os.Open(sourceName)
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	var timings []ffmpegrunner.Timing
	running, err := (ffmpegrunner.Runner{Path: ffmpeg, OnTiming: func(timing ffmpegrunner.Timing) { timings = append(timings, timing) }}).Start(context.Background(), contracts.PreviewSpec{Source: source, StartMS: 0, DurationMS: 800, Width: 160, Height: 90, FPS: 30, Audio: true})
	if err != nil {
		t.Fatal(err)
	}
	outputName := filepath.Join(dir, "preview.mp4")
	output, err := os.Create(outputName)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.Copy(output, running.Stdout); err != nil {
		t.Fatal(err)
	}
	if err := output.Close(); err != nil {
		t.Fatal(err)
	}
	if err := running.Wait(); err != nil {
		t.Fatal(err)
	}
	if err := ffmpegrunner.ValidateFile(context.Background(), ffprobe, outputName); err != nil {
		t.Fatal(err)
	}
	if len(timings) < 3 || timings[len(timings)-1].FirstByteAt.IsZero() || timings[len(timings)-1].CompletedAt.IsZero() || timings[len(timings)-1].SpawnToFirstByte <= 0 || timings[len(timings)-1].Total <= 0 {
		t.Fatalf("incomplete timings: %#v", timings)
	}
}

func TestPreviewCancellationAfterFirstByte(t *testing.T) {
	root, err := filepath.Abs("../../../")
	if err != nil {
		t.Fatal(err)
	}
	source, err := os.CreateTemp(t.TempDir(), "source")
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	running, err := (ffmpegrunner.Runner{Path: filepath.Join(root, "test", "harness", "fake-ffmpeg.sh"), GracePeriod: 100 * time.Millisecond}).Start(ctx, contracts.PreviewSpec{Source: source, DurationMS: 1, Width: 16, Height: 16, FPS: 1})
	if err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 16)
	if _, err := running.Stdout.Read(buf); err != nil {
		t.Fatal(err)
	}
	completed := make(chan error, 1)
	go func() { completed <- running.Wait() }()
	select {
	case err := <-completed:
		t.Fatalf("producer exited before first preview bytes were observable: %v", err)
	default:
	}
	cancel()
	select {
	case err := <-completed:
		if err == nil {
			t.Fatal("expected cancellation")
		}
	case <-time.After(time.Second):
		t.Fatal("cancelled producer did not exit")
	}
}
