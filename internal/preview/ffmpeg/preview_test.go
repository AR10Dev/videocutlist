package ffmpeg

import (
	"context"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"videocutlist/internal/fdinput"
	"videocutlist/internal/projects/model"
)

func init() {
	if os.Getenv("VIDEOCUTLIST_FFMPEG_HELPER") != "1" {
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
	t.Cleanup(func() {
		if err := source.Close(); err != nil {
			t.Error(err)
		}
	})
	args, err := BuildPreviewArgs(model.PreviewSpec{DurationMS: 1, Width: 1280, Height: 720, FPS: 30, Audio: true})
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(args, " ")
	if !strings.Contains(joined, "-i "+fdinput.Path(3)) || strings.Contains(joined, source.Name()) || !strings.Contains(joined, "-movflags +frag_keyframe+empty_moov+default_base_moof") {
		t.Fatalf("unsafe or incomplete ffmpeg args: %q", joined)
	}
}

func TestStartHonorsCancellation(t *testing.T) {
	t.Setenv("VIDEOCUTLIST_FFMPEG_HELPER", "1")
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
	running, err := (Runner{Path: os.Args[0]}).Start(ctx, source, model.PreviewSpec{DurationMS: 1, Width: 16, Height: 16, FPS: 1})
	if err != nil {
		t.Fatal(err)
	}
	cancel()
	if err := running.Wait(); err == nil || !strings.Contains(err.Error(), "context canceled") {
		t.Fatalf("Wait() error = %v, want cancellation", err)
	}
}

func TestTimingEmitsOnlyLifecycleMilestones(t *testing.T) {
	var mu sync.Mutex
	var emissions int
	state := &timingState{timing: Timing{SpawnedAt: time.Now()}, publish: func(Timing) {
		mu.Lock()
		emissions++
		mu.Unlock()
	}}
	state.emit()
	reader := &timedReadCloser{ReadCloser: io.NopCloser(strings.NewReader("abcdef")), state: state}
	buffer := make([]byte, 2)
	for range 3 {
		if _, err := reader.Read(buffer); err != nil {
			t.Fatal(err)
		}
	}
	mu.Lock()
	count := emissions
	mu.Unlock()
	if count != 2 {
		t.Fatalf("emissions = %d, want spawn and first byte only", count)
	}
	state.complete()
	mu.Lock()
	defer mu.Unlock()
	if emissions != 3 {
		t.Fatalf("final emissions = %d, want exactly completion added", emissions)
	}
}

func TestBoundedStderr(t *testing.T) {
	buffer := &boundedBuffer{limit: 4}
	if _, err := buffer.Write([]byte("123456")); err != nil || buffer.String() != "1234" {
		t.Fatalf("bounded stderr = %q, %v", buffer.String(), err)
	}
}
