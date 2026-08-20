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
	DurationMS   int64    `json:"durationMs"`
	Container    string   `json:"container"`
	Video        *Video   `json:"video,omitempty"`
	Audio        *Audio   `json:"audio,omitempty"`
	VideoStreams int      `json:"videoStreams"`
	AudioStreams int      `json:"audioStreams"`
	Streams      []Stream `json:"streams"`
}

type Stream struct {
	Index        int    `json:"index"`
	Type         string `json:"type"`
	Codec        string `json:"codec"`
	Width        int    `json:"width,omitempty"`
	Height       int    `json:"height,omitempty"`
	AvgFrameRate string `json:"avgFrameRate,omitempty"`
	Channels     int    `json:"channels,omitempty"`
}

type Video struct {
	Codec        string `json:"codec"`
	Width        int    `json:"width"`
	Height       int    `json:"height"`
	AvgFrameRate string `json:"avgFrameRate"`
	FrameRate    string `json:"frameRate,omitempty"`
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
// FrameTimes returns video frame timestamps in milliseconds from an open descriptor.
func (c Client) FrameTimes(ctx context.Context, source *os.File) ([]int64, error) {
	if source == nil {
		return nil, errors.New("ffprobe source is required")
	}
	path := c.Path
	if path == "" {
		path = "ffprobe"
	}
	cmd := exec.CommandContext(ctx, path, "-v", "error", "-select_streams", "v:0", "-show_entries", "frame=best_effort_timestamp_time", "-of", "json", "/proc/self/fd/3")
	cmd.ExtraFiles = []*os.File{source}
	var stdout, stderr limitedBuffer
	stdout.limit, stderr.limit = maxOutputBytes, maxOutputBytes
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("ffprobe frame times: %w", err)
	}
	var parsed struct {
		Frames []struct {
			Timestamp string `json:"best_effort_timestamp_time"`
		} `json:"frames"`
	}
	if err := json.Unmarshal(stdout.Bytes(), &parsed); err != nil {
		return nil, fmt.Errorf("ffprobe frame times: %w", err)
	}
	result := make([]int64, 0, len(parsed.Frames))
	for _, frame := range parsed.Frames {
		value, err := strconv.ParseFloat(frame.Timestamp, 64)
		if err != nil || value < 0 {
			return nil, errors.New("invalid video frame timestamp")
		}
		result = append(result, int64(math.Round(value*1000)))
	}
	if len(result) < 2 {
		return nil, errors.New("insufficient video frame timestamps")
	}
	return result, nil
}

// Keyframes returns video keyframe timestamps in milliseconds from an open descriptor.
func (c Client) Keyframes(ctx context.Context, source *os.File) ([]int64, error) {
	if source == nil {
		return nil, errors.New("ffprobe source is required")
	}
	path := c.Path
	if path == "" {
		path = "ffprobe"
	}
	cmd := exec.CommandContext(ctx, path, "-v", "error", "-select_streams", "v:0", "-show_entries", "frame=best_effort_timestamp_time,key_frame", "-of", "json", "/proc/self/fd/3")
	cmd.ExtraFiles = []*os.File{source}
	var stdout, stderr limitedBuffer
	stdout.limit, stderr.limit = maxOutputBytes, maxOutputBytes
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("ffprobe keyframes: %w", err)
	}
	var parsed struct {
		Frames []struct {
			Timestamp string `json:"best_effort_timestamp_time"`
			Key       int    `json:"key_frame"`
		} `json:"frames"`
	}
	if err := json.Unmarshal(stdout.Bytes(), &parsed); err != nil {
		return nil, fmt.Errorf("ffprobe keyframes: %w", err)
	}
	result := make([]int64, 0)
	for _, frame := range parsed.Frames {
		if frame.Key != 1 {
			continue
		}
		value, err := strconv.ParseFloat(frame.Timestamp, 64)
		if err == nil && value >= 0 {
			result = append(result, int64(math.Round(value*1000)))
		}
	}
	if len(result) == 0 {
		return nil, errors.New("no video keyframes")
	}
	return result, nil
}

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
		"-show_entries", "format=duration,format_name:stream=index,codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate,channels",
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
		Index        int    `json:"index"`
		Type         string `json:"codec_type"`
		Codec        string `json:"codec_name"`
		Width        int    `json:"width"`
		Height       int    `json:"height"`
		AvgFrameRate string `json:"avg_frame_rate"`
		FrameRate    string `json:"r_frame_rate"`
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
		result.Streams = append(result.Streams, Stream{Index: stream.Index, Type: stream.Type, Codec: stream.Codec, Width: stream.Width, Height: stream.Height, AvgFrameRate: stream.AvgFrameRate, Channels: stream.Channels})
		switch stream.Type {
		case "video":
			result.VideoStreams++
			if result.Video == nil {
				result.Video = &Video{Codec: stream.Codec, Width: stream.Width, Height: stream.Height, AvgFrameRate: stream.AvgFrameRate, FrameRate: stream.FrameRate}
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
