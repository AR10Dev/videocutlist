package probe

import (
	"context"
	"fmt"
	"os"
	"testing"
)

func init() {
	if os.Getenv("EDITAPP_TEST_FFPROBE") != "1" {
		return
	}
	if os.Getenv("EDITAPP_TEST_FFPROBE_FD") == "1" {
		data, err := os.ReadFile("/proc/self/fd/3")
		if err != nil || string(data) != "opened-media" {
			os.Exit(2)
		}
	}
	fmt.Fprint(os.Stdout, `{"format":{"duration":"1.2345","format_name":"mov,mp4"},"streams":[{"codec_type":"video","codec_name":"h264","width":320,"height":180,"avg_frame_rate":"30/1"},{"codec_type":"audio","codec_name":"aac","channels":2}]}`)
	os.Exit(0)
}

func TestClientProbesOpenFile(t *testing.T) {
	t.Setenv("EDITAPP_TEST_FFPROBE", "1")
	t.Setenv("EDITAPP_TEST_FFPROBE_FD", "1")
	source, err := os.CreateTemp(t.TempDir(), "media-*.mp4")
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
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
	t.Setenv("EDITAPP_TEST_FFPROBE", "1")
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
