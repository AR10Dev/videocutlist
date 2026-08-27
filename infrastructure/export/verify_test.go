package export

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"videocutlist/infrastructure/media/probe"
)

func fakeFFprobe(t *testing.T, output probe.Metadata) (string, string) {
	t.Helper()
	dir := t.TempDir()
	input := filepath.Join(dir, "output.mkv")
	if err := os.WriteFile(input, []byte("fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	var streams []string
	for _, stream := range output.Streams {
		language := ""
		if stream.Language != "" {
			language = fmt.Sprintf(",\"tags\":{\"language\":%q}", stream.Language)
		}
		streams = append(streams, fmt.Sprintf(`{"index":%d,"codec_type":%q,"codec_name":%q,"channels":%d%s,"disposition":{}}`, stream.Index, stream.Type, stream.Codec, stream.Channels, language))
	}
	json := fmt.Sprintf(`{"format":{"duration":"%g","format_name":%q},"streams":[%s]}`, float64(output.DurationMS)/1000, output.Container, strings.Join(streams, ","))
	response := filepath.Join(dir, "response.json")
	if err := os.WriteFile(response, []byte(json), 0600); err != nil {
		t.Fatal(err)
	}
	ffprobe := filepath.Join(dir, "ffprobe")
	script := "#!/bin/sh\ncat " + response + "\n"
	if err := os.WriteFile(ffprobe, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	return ffprobe, input
}

func sourceStreams() probe.Metadata {
	return probe.Metadata{Streams: []probe.Stream{
		{Index: 0, Type: "video", Codec: "h264"},
		{Index: 1, Type: "audio", Codec: "aac", Language: "eng", Channels: 2},
		{Index: 2, Type: "audio", Codec: "aac", Language: "ita", Channels: 2},
		{Index: 3, Type: "subtitle", Codec: "subrip", Language: "eng"},
	}}
}

func TestVerifyOutputAcceptsSelectedStreamCombinations(t *testing.T) {
	source := sourceStreams()
	for _, test := range []struct {
		name     string
		selected []int
		streams  []probe.Stream
	}{
		{"video-only", []int{0}, []probe.Stream{source.Streams[0]}},
		{"multi-audio", []int{0, 1, 2}, []probe.Stream{source.Streams[0], source.Streams[1], source.Streams[2]}},
		{"subtitle", []int{0, 3}, []probe.Stream{source.Streams[0], source.Streams[3]}},
	} {
		t.Run(test.name, func(t *testing.T) {
			ffprobe, output := fakeFFprobe(t, probe.Metadata{Container: "matroska,webm", DurationMS: 2000, Streams: test.streams})
			if err := verifyOutput(context.Background(), ffprobe, output, source, test.selected, 2000); err != nil {
				t.Fatalf("VerifyOutput() error = %v", err)
			}
		})
	}
}

func TestVerifyOutputRejectsInvalidArtifacts(t *testing.T) {
	source := sourceStreams()
	tests := []struct {
		name     string
		output   probe.Metadata
		selected []int
		expected string
	}{
		{"missing-selected-stream", probe.Metadata{Container: "matroska", DurationMS: 2000, Streams: []probe.Stream{source.Streams[0]}}, []int{0, 1}, "missing selected stream"},
		{"wrong-language", probe.Metadata{Container: "matroska", DurationMS: 2000, Streams: []probe.Stream{source.Streams[0], {Type: "audio", Codec: "aac", Language: "fra", Channels: 2}}}, []int{0, 1}, "missing selected stream"},
		{"forbidden-attachment", probe.Metadata{Container: "matroska", DurationMS: 2000, Streams: []probe.Stream{{Type: "video", Codec: "h264"}, {Type: "attachment", Codec: "ttf"}}}, []int{0}, "forbidden attachment"},
		{"zero-duration", probe.Metadata{Container: "matroska", DurationMS: 0, Streams: []probe.Stream{source.Streams[0]}}, []int{0}, "ffprobe metadata"},
		{"implausible-duration", probe.Metadata{Container: "matroska", DurationMS: 7000, Streams: []probe.Stream{source.Streams[0]}}, []int{0}, "implausible"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			ffprobe, output := fakeFFprobe(t, test.output)
			err := verifyOutput(context.Background(), ffprobe, output, source, test.selected, 2000)
			if err == nil || !strings.Contains(err.Error(), test.expected) {
				t.Fatalf("error = %v, want substring %q", err, test.expected)
			}
		})
	}
}

func TestVerifyOutputRejectsAbsentDuration(t *testing.T) {
	dir := t.TempDir()
	input := filepath.Join(dir, "output.mkv")
	if err := os.WriteFile(input, []byte("fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	ffprobe := filepath.Join(dir, "ffprobe")
	script := "#!/bin/sh\nprintf '%s' '\u007b\"format\":\u007b\"format_name\":\"matroska\"\u007d,\"streams\":[\u007b\"index\":0,\"codec_type\":\"video\",\"codec_name\":\"h264\",\"disposition\":\u007b\u007d\u007d]}\n'\n"
	if err := os.WriteFile(ffprobe, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	if err := verifyOutput(context.Background(), ffprobe, input, sourceStreams(), []int{0}, 2000); err == nil {
		t.Fatal("output with absent duration was accepted")
	}
}

func TestVerifyOutputRejectsProbeCorruptionAndInvalidContainer(t *testing.T) {
	dir := t.TempDir()
	input := filepath.Join(dir, "output.mkv")
	if err := os.WriteFile(input, []byte("fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	ffprobe := filepath.Join(dir, "ffprobe")
	if err := os.WriteFile(ffprobe, []byte("#!/bin/sh\nprintf 'not json'\n"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := verifyOutput(context.Background(), ffprobe, input, sourceStreams(), []int{0}, 2000); err == nil {
		t.Fatal("corrupt probe output was accepted")
	}

	ffprobe, output := fakeFFprobe(t, probe.Metadata{Container: "mp4", DurationMS: 2000, Streams: []probe.Stream{sourceStreams().Streams[0]}})
	if err := verifyOutput(context.Background(), ffprobe, output, sourceStreams(), []int{0}, 2000); err == nil || !strings.Contains(err.Error(), "container") {
		t.Fatalf("error = %v, want container rejection", err)
	}
}
