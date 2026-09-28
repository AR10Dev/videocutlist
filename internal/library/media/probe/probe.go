// Package probe runs ffprobe with a fixed, machine-readable query.
package probe

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"os/exec"
	"slices"
	"strconv"
	"strings"

	"videocutlist/internal/fdinput"
)

const maxOutputBytes = 1 << 20

var ErrOutputTooLarge = errors.New("ffprobe output exceeds limit")

// Metadata is the stable subset of ffprobe output used by the projects.
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
	Index        int      `json:"index"`
	Type         string   `json:"type"`
	Codec        string   `json:"codec"`
	Language     string   `json:"language,omitempty"`
	Disposition  []string `json:"disposition,omitempty"`
	Width        int      `json:"width,omitempty"`
	Height       int      `json:"height,omitempty"`
	AvgFrameRate string   `json:"avgFrameRate,omitempty"`
	Channels     int      `json:"channels,omitempty"`
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
	return c.frameTimestamps(ctx, source, false)
}

// Keyframes returns video keyframe timestamps in milliseconds from an open descriptor.
func (c Client) Keyframes(ctx context.Context, source *os.File) ([]int64, error) {
	return c.frameTimestamps(ctx, source, true)
}

// FFprobe's CSV query emits one timestamp per line. Consume it as it arrives:
// a fixed stdout cap would reject ordinary long recordings, while decoding the
// entire JSON response would keep both the response and its frames in memory.
func (c Client) frameTimestamps(ctx context.Context, source *os.File, keyframes bool) ([]int64, error) {
	if source == nil {
		return nil, errors.New("ffprobe source is required")
	}
	path := c.Path
	if path == "" {
		path = "ffprobe"
	}
	args := []string{"-v", "error", "-select_streams", "v:0"}
	if keyframes {
		args = append(args, "-skip_frame", "nokey")
	}
	args = append(args, "-show_frames", "-show_entries", "frame=best_effort_timestamp_time", "-of", "csv=p=0", fdinput.Path(3))
	cmd := exec.CommandContext(ctx, path, args...)
	cmd.ExtraFiles = []*os.File{source}
	var stderr limitedBuffer
	stderr.limit = maxOutputBytes
	cmd.Stderr = &stderr
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("ffprobe frames: %w", err)
	}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("ffprobe frames: %w", err)
	}
	const maxFrameLineBytes = 64 << 10
	const maxFrameTimestamps = 1 << 23 // 64 MiB of int64 timestamps at most.
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 128), maxFrameLineBytes)
	result := make([]int64, 0)
	var parseErr error
	for scanner.Scan() {
		// FFprobe appends side-data descriptions (such as H.264 SEI) as
		// additional CSV fields even when only the timestamp was requested.
		timestamp, _, _ := strings.Cut(scanner.Text(), ",")
		value, err := strconv.ParseFloat(timestamp, 64)
		if err != nil || math.IsNaN(value) || math.IsInf(value, 0) || value < 0 || value > float64(math.MaxInt64)/1000 {
			parseErr = errors.New("invalid video frame timestamp")
			break
		}
		if len(result) == maxFrameTimestamps {
			parseErr = ErrOutputTooLarge
			break
		}
		result = append(result, int64(math.Round(value*1000)))
	}
	if parseErr == nil {
		parseErr = scanner.Err()
	}
	if parseErr != nil {
		_ = cmd.Process.Kill()
	}
	waitErr := cmd.Wait()
	if errors.Is(stderr.err, ErrOutputTooLarge) {
		return nil, ErrOutputTooLarge
	}
	if parseErr != nil {
		return nil, fmt.Errorf("ffprobe frames: %w", parseErr)
	}
	if waitErr != nil {
		return nil, fmt.Errorf("ffprobe frames: %w", waitErr)
	}
	if keyframes && len(result) == 0 {
		return nil, errors.New("no video keyframes")
	}
	if !keyframes && len(result) < 2 {
		return nil, errors.New("insufficient video frame timestamps")
	}
	return result, nil
}

func (c Client) ProbeFile(ctx context.Context, source *os.File) (Metadata, error) {
	if source == nil {
		return Metadata{}, errors.New("ffprobe source is required")
	}
	return c.run(ctx, fdinput.Path(3), []*os.File{source})
}

func (c Client) run(ctx context.Context, input string, files []*os.File) (Metadata, error) {
	path := c.Path
	if path == "" {
		path = "ffprobe"
	}
	cmd := exec.CommandContext(ctx, path,
		"-v", "error",
		"-show_entries", "format=duration,format_name:stream=index,codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate,channels:stream_tags=language:stream_disposition",
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
		Tags         struct {
			Language string `json:"language"`
		} `json:"tags"`
		Disposition map[string]int `json:"disposition"`
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
		disposition := make([]string, 0)
		for name, enabled := range stream.Disposition {
			if enabled != 0 {
				disposition = append(disposition, name)
			}
		}
		slices.Sort(disposition)
		result.Streams = append(result.Streams, Stream{Index: stream.Index, Type: stream.Type, Codec: stream.Codec, Language: stream.Tags.Language, Disposition: disposition, Width: stream.Width, Height: stream.Height, AvgFrameRate: stream.AvgFrameRate, Channels: stream.Channels})
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
