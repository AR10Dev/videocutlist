package export

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"slices"
	"strings"

	"videocutlist/internal/exportpolicy"
)

func (s Service) checkCapabilities(ctx context.Context, policy exportpolicy.Policy, strategy string) error {
	features := []struct {
		listing string
		name    string
	}{
		{"-muxers", policy.Muxer},
	}
	if strategy == "precise_reencode" || strategy == "hybrid_smart_cut" {
		features = append(features,
			struct {
				listing string
				name    string
			}{"-encoders", "libx264"},
			struct {
				listing string
				name    string
			}{"-encoders", "aac"},
		)
	}
	for _, feature := range features {
		available, err := s.ffmpegFeature(ctx, feature.listing, feature.name)
		if err != nil {
			return err
		}
		if !available {
			return fmt.Errorf("FFmpeg feature %q is unavailable", feature.name)
		}
	}
	return nil
}

func (s Service) ffmpegFeature(ctx context.Context, listing, feature string) (bool, error) {
	path := s.FFmpegPath
	if path == "" {
		path = "ffmpeg"
	}
	cmd := exec.Command(path, "-hide_banner", listing)
	var stdout, stderr limitedBuffer
	stdout.limit, stderr.limit = maxStderrBytes, maxStderrBytes
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := runCommand(ctx, cmd); err != nil {
		if ctx.Err() != nil {
			return false, ctx.Err()
		}
		return false, fmt.Errorf("FFmpeg capability check failed: %w", err)
	}
	if stdout.err != nil || stderr.err != nil {
		return false, errors.New("FFmpeg capability output exceeded limit")
	}
	for line := range strings.SplitSeq(stdout.String(), "\n") {
		if slices.Contains(strings.Fields(line), feature) {
			return true, nil
		}
	}
	return false, nil
}
