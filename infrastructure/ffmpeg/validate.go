package ffmpeg

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
)

// ValidateFile accepts only the software-preview fMP4 profile before cache publication.
func ValidateFile(ctx context.Context, ffprobePath, filename string) error {
	if ffprobePath == "" {
		ffprobePath = "ffprobe"
	}
	cmd := exec.CommandContext(ctx, ffprobePath, "-v", "error", "-show_entries", "format=format_name:stream=codec_type,codec_name,width,height,pix_fmt,avg_frame_rate,channels,sample_rate", "-of", "json", filename)
	var stdout, stderr boundedBuffer
	stdout.limit, stderr.limit = defaultStderr, defaultStderr
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("ffprobe preview: %w: %s", err, stderr.String())
	}
	var output struct {
		Format struct {
			Name string `json:"format_name"`
		} `json:"format"`
		Streams []struct {
			Type     string `json:"codec_type"`
			Codec    string `json:"codec_name"`
			Width    int    `json:"width"`
			Height   int    `json:"height"`
			PixFmt   string `json:"pix_fmt"`
			Rate     string `json:"avg_frame_rate"`
			Channels int    `json:"channels"`
			Sample   string `json:"sample_rate"`
		} `json:"streams"`
	}
	if err := json.Unmarshal(stdout.Bytes(), &output); err != nil {
		return fmt.Errorf("ffprobe preview output: %w", err)
	}
	if !strings.Contains(output.Format.Name, "mp4") {
		return fmt.Errorf("preview container is %q, not mp4", output.Format.Name)
	}
	var video bool
	for _, stream := range output.Streams {
		switch stream.Type {
		case "video":
			fps, err := frameRate(stream.Rate)
			if err != nil || stream.Codec != "h264" || stream.PixFmt != "yuv420p" || stream.Width < 1 || stream.Height < 1 || stream.Width > 1280 || stream.Height > 720 || fps > 30 {
				return fmt.Errorf("invalid preview video stream")
			}
			video = true
		case "audio":
			if stream.Codec != "aac" || stream.Channels != 2 || stream.Sample != "48000" {
				return fmt.Errorf("invalid preview audio stream")
			}
		}
	}
	if !video {
		return fmt.Errorf("preview has no h264 video stream")
	}
	return nil
}

func frameRate(value string) (float64, error) {
	parts := strings.Split(value, "/")
	if len(parts) != 2 {
		return 0, fmt.Errorf("invalid frame rate %q", value)
	}
	numerator, err := strconv.ParseFloat(parts[0], 64)
	if err != nil || numerator <= 0 {
		return 0, fmt.Errorf("invalid frame rate %q", value)
	}
	denominator, err := strconv.ParseFloat(parts[1], 64)
	if err != nil || denominator <= 0 {
		return 0, fmt.Errorf("invalid frame rate %q", value)
	}
	return numerator / denominator, nil
}
