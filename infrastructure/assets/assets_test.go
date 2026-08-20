package assets

import (
	"context"

	"os"
	"os/exec"
	"testing"
	"videocutlist/application"
)

func TestValidateRejectsExcessiveWaveformSamples(t *testing.T) {
	if err := validate(application.AssetSpec{DurationMS: 1, Samples: maxWaveformSamples + 1}, true); err == nil {
		t.Fatal("validate accepted excessive waveform samples")
	}
}

func TestRunRejectsOversizedOutput(t *testing.T) {
	if _, err := exec.LookPath("sh"); err != nil {
		t.Skip("sh unavailable")
	}
	source, err := os.Open(os.DevNull)
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	_, err = run(context.Background(), "sh", source, []string{"-c", "dd if=/dev/zero bs=1024 count=2 2>/dev/null"}, 1024)
	if err == nil || err.Error() != "asset output exceeds bound" {
		t.Fatalf("run error = %v, want oversized output error", err)
	}
}

func TestRunUsesDescriptorAndProducesPNG(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg unavailable")
	}
	source, err := os.CreateTemp(t.TempDir(), "fixture-*.mp4")
	if err != nil {
		t.Fatal(err)
	}
	source.Close()
	// Generate a deterministic fixture, then reopen it as the descriptor supplied to run.
	if err := exec.Command("ffmpeg", "-y", "-f", "lavfi", "-i", "color=c=blue:s=64x64:d=1", "-pix_fmt", "yuv420p", source.Name()).Run(); err != nil {
		t.Fatal(err)
	}
	source, err = os.Open(source.Name())
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	data, err := run(context.Background(), "ffmpeg", source, []string{"-nostdin", "-hide_banner", "-loglevel", "error", "-i", "/proc/self/fd/3", "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "pipe:1"}, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	if len(data) < 8 || string(data[:8]) != "\x89PNG\r\n\x1a\n" {
		t.Fatalf("not PNG output: %d bytes", len(data))
	}
}
