package probe

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"testing"
)

func init() {
	if os.Getenv("VIDEOCUTLIST_TEST_FRAMES") == "1" {
		keyOnly := slices.Contains(os.Args, "-skip_frame")
		output := bufio.NewWriter(os.Stdout)
		count := 110_000
		if keyOnly {
			count = 2
		}
		for i := range count {
			if _, err := fmt.Fprintf(output, "%d.000000\n", i); err != nil {
				os.Exit(2)
			}
		}
		if err := output.Flush(); err != nil {
			os.Exit(2)
		}
		os.Exit(0)
	}
	if os.Getenv("VIDEOCUTLIST_TEST_FFPROBE") != "1" {
		return
	}
	if os.Getenv("VIDEOCUTLIST_TEST_FFPROBE_FD") == "1" {
		data, err := os.ReadFile("/proc/self/fd/3")
		if err != nil || string(data) != "opened-media" {
			os.Exit(2)
		}
	}
	if _, err := fmt.Fprint(os.Stdout, `{"format":{"duration":"1.2345","format_name":"mov,mp4"},"streams":[{"codec_type":"video","codec_name":"h264","width":320,"height":180,"avg_frame_rate":"30/1"},{"codec_type":"audio","codec_name":"aac","channels":2}]}`); err != nil {
		os.Exit(2)
	}
	os.Exit(0)
}

func TestClientProbesOpenFile(t *testing.T) {
	t.Setenv("VIDEOCUTLIST_TEST_FFPROBE", "1")
	t.Setenv("VIDEOCUTLIST_TEST_FFPROBE_FD", "1")
	source, err := os.CreateTemp(t.TempDir(), "media-*.mp4")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := source.Close(); err != nil {
			t.Error(err)
		}
	})
	if _, err := source.WriteString("opened-media"); err != nil {
		t.Fatal(err)
	}
	if _, err := source.Seek(0, 0); err != nil {
		t.Fatal(err)
	}
	if _, err := (Client{Path: os.Args[0]}).ProbeFile(context.Background(), source); err != nil {
		t.Fatal(err)
	}
}

func TestClientNormalizesOutput(t *testing.T) {
	t.Setenv("VIDEOCUTLIST_TEST_FFPROBE", "1")
	metadata, err := (Client{Path: os.Args[0]}).Probe(context.Background(), "-not-a-shell-command.mp4")
	if err != nil {
		t.Fatal(err)
	}
	if metadata.DurationMS != 1235 || metadata.Container != "mov,mp4" || metadata.Video == nil || metadata.Video.Codec != "h264" || metadata.AudioStreams != 1 {
		t.Fatalf("unexpected metadata: %#v", metadata)
	}
}

func TestNormalizeRejectsAudioOnly(t *testing.T) {
	if _, err := normalize([]byte(`{"format":{"duration":"1"},"streams":[{"codec_type":"audio"}]}`)); err == nil {
		t.Fatal("expected no-video error")
	}
}

func TestNormalizeRejectsZeroDuration(t *testing.T) {
	if _, err := normalize([]byte(`{"format":{"duration":"0.0004"},"streams":[{"codec_type":"video"}]}`)); err == nil {
		t.Fatal("expected invalid duration error")
	}
}

func TestFrameQueriesAcceptLongVideosAndSelectOnlyKeyframes(t *testing.T) {
	t.Setenv("VIDEOCUTLIST_TEST_FRAMES", "1")
	source, err := os.CreateTemp(t.TempDir(), "media-*.mkv")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = source.Close() })
	client := Client{Path: os.Args[0]}
	frames, err := client.FrameTimes(t.Context(), source)
	if err != nil {
		t.Fatal(err)
	}
	if len(frames) != 110_000 || frames[0] != 0 || frames[len(frames)-1] != 109_999_000 {
		t.Fatalf("unexpected frame timestamps: count %d, last %d", len(frames), frames[len(frames)-1])
	}
	keyframes, err := client.Keyframes(t.Context(), source)
	if err != nil {
		t.Fatal(err)
	}
	if len(keyframes) != 2 || keyframes[0] != 0 || keyframes[1] != 1000 {
		t.Fatalf("keyframe-only query returned %v", keyframes)
	}
}

func TestFrameQueriesUseActualFFprobe(t *testing.T) {
	ffmpeg, encodeErr := exec.LookPath("ffmpeg")
	ffprobe, probeErr := exec.LookPath("ffprobe")
	if encodeErr != nil || probeErr != nil {
		t.Skip("ffmpeg and ffprobe are required for the actual media smoke test")
	}
	filename := filepath.Join(t.TempDir(), "frames.mkv")
	cmd := exec.CommandContext(t.Context(), ffmpeg, "-v", "error", "-f", "lavfi", "-i", "color=c=red:s=16x16:r=30:d=2", "-c:v", "libx264", "-g", "30", "-pix_fmt", "yuv420p", filename)
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("encode short smoke fixture: %v: %s", err, output)
	}
	source, err := os.Open(filename)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = source.Close() }()
	client := Client{Path: ffprobe}
	frames, err := client.FrameTimes(t.Context(), source)
	if err != nil {
		t.Fatal(err)
	}
	keyframes, err := client.Keyframes(t.Context(), source)
	if err != nil {
		t.Fatal(err)
	}
	if len(frames) != 60 || len(keyframes) != 2 || frames[0] != 0 || keyframes[0] != 0 || keyframes[1] != 1000 {
		t.Fatalf("real ffprobe returned %d frames and keyframes %v", len(frames), keyframes)
	}
}
