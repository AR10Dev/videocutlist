package ffmpeg

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"editapp/domain"
)

func init() {
	if os.Getenv("EDITAPP_FFMPEG_HELPER") != "1" {
		return
	}
	_, _ = fmt.Fprint(os.Stdout, "ftyp")
	for {
		time.Sleep(time.Hour)
	}
}

func TestBuildPreviewArgsUsesInheritedFD(t *testing.T) {
	source, err := os.CreateTemp(t.TempDir(), "source")
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	args, err := BuildPreviewArgs(domain.PreviewSpec{DurationMS: 1, Width: 1280, Height: 720, FPS: 30, Audio: true})
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(args, " ")
	if !strings.Contains(joined, "-i "+fdInput) || strings.Contains(joined, source.Name()) || !strings.Contains(joined, "-movflags +frag_keyframe+empty_moov+default_base_moof") {
		t.Fatalf("unsafe or incomplete ffmpeg args: %q", joined)
	}
}

func TestStartHonorsCancellation(t *testing.T) {
	t.Setenv("EDITAPP_FFMPEG_HELPER", "1")
	source, err := os.CreateTemp(t.TempDir(), "source")
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	ctx, cancel := context.WithCancel(context.Background())
	running, err := (Runner{Path: os.Args[0]}).Start(ctx, source, domain.PreviewSpec{DurationMS: 1, Width: 16, Height: 16, FPS: 1})
	if err != nil {
		t.Fatal(err)
	}
	cancel()
	if err := running.Wait(); err == nil || !strings.Contains(err.Error(), "context canceled") {
		t.Fatalf("Wait() error = %v, want cancellation", err)
	}
}

func TestBoundedStderr(t *testing.T) {
	buffer := &boundedBuffer{limit: 4}
	if _, err := buffer.Write([]byte("123456")); err != nil || buffer.String() != "1234" {
		t.Fatalf("bounded stderr = %q, %v", buffer.String(), err)
	}
}
