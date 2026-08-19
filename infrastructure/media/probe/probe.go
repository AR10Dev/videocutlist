// Package probe runs ffprobe with a fixed, machine-readable query.
package probe

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"os/exec"
	"strconv"
	"strings"
)

const maxOutputBytes = 1 << 20

var ErrOutputTooLarge = errors.New("ffprobe output exceeds limit")

// Metadata is the stable subset of ffprobe output used by the application.
type Metadata struct {
	DurationMS   int64  `json:"durationMs"`
	Container    string `json:"container"`
	Video        *Video `json:"video,omitempty"`
	Audio        *Audio `json:"audio,omitempty"`
	VideoStreams int    `json:"videoStreams"`
	AudioStreams int    `json:"audioStreams"`
}

type Video struct {
	Codec        string `json:"codec"`
	Width        int    `json:"width"`
	Height       int    `json:"height"`
	AvgFrameRate string `json:"avgFrameRate"`
}

type Audio struct {
	Codec    string `json:"codec"`
	Channels int    `json:"channels"`
}

// Runner allows the indexer to probe an already-open media descriptor.
type Runner interface {
	ProbeFile(context.Context, *os.File) (Metadata, error)
}

type Client struct {
	Path string
}

func (c Client) Probe(ctx context.Context, filename string) (Metadata, error) {
	return c.run(ctx, filename, nil)
}

// ProbeFile passes source as child descriptor 3 so FFprobe never reopens a
// pathname after the media resolver has checked it.
func (c Client) ProbeFile(ctx context.Context, source *os.File) (Metadata, error) {
	if source == nil {
		return Metadata{}, errors.New("ffprobe source is required")
	}
	return c.run(ctx, "/proc/self/fd/3", []*os.File{source})
}

func (c Client) run(ctx context.Context, input string, files []*os.File) (Metadata, error) {
	path := c.Path
	if path == "" {
		path = "ffprobe"
	}
	cmd := exec.CommandContext(ctx, path,
		"-v", "error",
		"-show_entries", "format=duration,format_name:stream=index,codec_type,codec_name,width,height,avg_frame_rate,channels",
		"-of", "json",
		input,
	)
	cmd.ExtraFiles = files
	var stdout, stderr limitedBuffer
	stdout.limit, stderr.limit = maxOutputBytes, maxOutputBytes
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		if errors.Is(stdout.err, ErrOutputTooLarge) || errors.Is(stderr.err, ErrOutputTooLarge) {
			return Metadata{}, ErrOutputTooLarge
		}
		return Metadata{}, fmt.Errorf("ffprobe: %w", err)
	}
	if stdout.err != nil || stderr.err != nil {
		return Metadata{}, ErrOutputTooLarge
	}
	metadata, err := normalize(stdout.Bytes())
	if err != nil {
		return Metadata{}, fmt.Errorf("ffprobe metadata: %w", err)
	}
	return metadata, nil
}

type limitedBuffer struct {
	bytes.Buffer
	limit int
	err   error
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	if b.err != nil {
		return 0, b.err
	}
	if b.Len()+len(p) > b.limit {
		b.err = ErrOutputTooLarge
		return 0, b.err
	}
	return b.Buffer.Write(p)
}

type response struct {
	Format struct {
		Duration string `json:"duration"`
		Name     string `json:"format_name"`
	} `json:"format"`
	Streams []struct {
		Type         string `json:"codec_type"`
		Codec        string `json:"codec_name"`
		Width        int    `json:"width"`
		Height       int    `json:"height"`
		AvgFrameRate string `json:"avg_frame_rate"`
		Channels     int    `json:"channels"`
	} `json:"streams"`
}

func normalize(data []byte) (Metadata, error) {
	var parsed response
	if err := json.Unmarshal(data, &parsed); err != nil {
		return Metadata{}, err
	}
	duration, err := strconv.ParseFloat(parsed.Format.Duration, 64)
	if err != nil || duration < 0 || math.IsNaN(duration) || math.IsInf(duration, 0) {
		return Metadata{}, fmt.Errorf("invalid duration %q", parsed.Format.Duration)
	}
	result := Metadata{DurationMS: int64(math.Round(duration * 1000)), Container: parsed.Format.Name}
	if result.DurationMS < 1 {
		return Metadata{}, fmt.Errorf("invalid duration %q", parsed.Format.Duration)
	}
	for _, stream := range parsed.Streams {
		switch stream.Type {
		case "video":
			result.VideoStreams++
			if result.Video == nil {
				result.Video = &Video{Codec: stream.Codec, Width: stream.Width, Height: stream.Height, AvgFrameRate: stream.AvgFrameRate}
			}
		case "audio":
			result.AudioStreams++
			if result.Audio == nil {
				result.Audio = &Audio{Codec: stream.Codec, Channels: stream.Channels}
			}
		}
	}
	if result.Video == nil {
		return Metadata{}, errors.New("no video stream")
	}
	result.Container = strings.TrimSpace(result.Container)
	return result, nil
}
