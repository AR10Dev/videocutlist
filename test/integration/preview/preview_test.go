package preview_test

import (
	"context"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"videocutlist/internal/preview"
	ffmpegrunner "videocutlist/internal/preview/ffmpeg"
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
	t.Cleanup(func() {
		if err := source.Close(); err != nil {
			t.Error(err)
		}
	})
	var timings []ffmpegrunner.Timing
	running, err := (ffmpegrunner.Runner{Path: ffmpeg, OnTiming: func(timing ffmpegrunner.Timing) { timings = append(timings, timing) }}).Start(context.Background(), source, preview.TranscodeSpec{StartMS: 0, DurationMS: 800, Width: 160, Height: 90, FPS: 30, Audio: true})
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
	preview, err := os.Open(outputName)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := preview.Close(); err != nil {
			t.Error(err)
		}
	})
	// Validation must inspect the open preview, not a replacement at its name.
	if err := os.Rename(outputName, outputName+".retained"); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(outputName, []byte("not a preview"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := ffmpegrunner.ValidateFile(context.Background(), ffprobe, preview); err != nil {
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
	t.Cleanup(func() {
		if err := source.Close(); err != nil {
			t.Error(err)
		}
	})
	ctx, cancel := context.WithCancel(context.Background())
	running, err := (ffmpegrunner.Runner{Path: filepath.Join(root, "test", "harness", "fake-ffmpeg.sh"), GracePeriod: 100 * time.Millisecond}).Start(ctx, source, preview.TranscodeSpec{DurationMS: 1, Width: 16, Height: 16, FPS: 1})
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	waitDone := make(chan struct{})
	var waitErr error
	go func() {
		waitErr = running.Wait()
		close(waitDone)
	}()
	readDone := make(chan struct{})
	readResult := make(chan struct {
		n   int
		err error
	}, 1)
	go func() {
		buf := make([]byte, 16)
		n, readErr := running.Stdout.Read(buf)
		readResult <- struct {
			n   int
			err error
		}{n: n, err: readErr}
		close(readDone)
	}()
	t.Cleanup(func() {
		cancel()
		_ = running.Stdout.Close()
		select {
		case <-waitDone:
		case <-time.After(time.Second):
			t.Error("preview producer was not reaped during cleanup")
		}
		select {
		case <-readDone:
		case <-time.After(time.Second):
			t.Error("preview byte read did not unblock during cleanup")
		}
	})
	select {
	case result := <-readResult:
		if result.err != nil || result.n == 0 {
			t.Fatalf("first preview read = %d bytes, %v", result.n, result.err)
		}
	case <-time.After(time.Second):
		t.Fatal("preview producer did not emit its first byte")
	}
	select {
	case <-waitDone:
		t.Fatalf("producer exited before first preview bytes were observable: %v", waitErr)
	default:
	}
	cancel()
	select {
	case <-waitDone:
		if waitErr == nil {
			t.Fatal("expected cancellation")
		}
	case <-time.After(time.Second):
		t.Fatal("cancelled producer did not exit")
	}
}
