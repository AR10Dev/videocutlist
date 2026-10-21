package export

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"videocutlist/internal/exportpolicy"
	"videocutlist/internal/library/media/probe"
	"videocutlist/internal/projects/model"
)

func hybridMetadataCapabilityReasons(metadata probe.Metadata, sourceName string) []string {
	var reasons []string
	if metadata.Container != "matroska,webm" {
		reasons = append(reasons, "unsupported_container")
	}
	if strings.ToLower(filepath.Ext(sourceName)) != ".mkv" {
		reasons = append(reasons, "unsupported_filename_extension")
	}
	if metadata.Video == nil || !strings.EqualFold(metadata.Video.Codec, "h264") {
		reasons = append(reasons, "unsupported_video_codec")
	} else if !validCFR(metadata.Video.AvgFrameRate, metadata.Video.FrameRate) {
		reasons = append(reasons, "non_constant_frame_rate")
	}
	return reasons
}

func hybridCapabilityReasons(metadata probe.Metadata, sourceName string, frameTimes []int64) []string {
	reasons := hybridMetadataCapabilityReasons(metadata, sourceName)
	if !constantFrameTimes(frameTimes) {
		reasons = append(reasons, "non_constant_frame_timestamps")
	}
	return reasons
}

func validCFR(avg, rate string) bool {
	parse := func(value string) (int64, int64, bool) {
		parts := strings.Split(value, "/")
		if len(parts) != 2 {
			return 0, 0, false
		}
		n, e1 := strconv.ParseInt(parts[0], 10, 64)
		d, e2 := strconv.ParseInt(parts[1], 10, 64)
		return n, d, e1 == nil && e2 == nil && n > 0 && d > 0
	}
	an, ad, ok := parse(avg)
	rn, rd, rok := parse(rate)
	return ok && rok && an*rd == rn*ad
}

func constantFrameTimes(times []int64) bool {
	if len(times) < 2 {
		return false
	}
	delta := times[1] - times[0]
	if delta <= 0 {
		return false
	}
	for i := 2; i < len(times); i++ {
		step := times[i] - times[i-1]
		if step <= 0 || abs64(step-delta) > 1 {
			return false
		}
	}
	return true
}

func abs64(value int64) int64 {
	if value < 0 {
		return -value
	}
	return value
}

func hasInteriorKeyframe(segment model.Segment, keyframes []int64) bool {
	for _, keyframe := range keyframes {
		if keyframe > segment.StartMS && keyframe < segment.EndMS {
			return true
		}
	}
	return false
}

func hybridWarnings(segments []model.Segment, keyframes []int64, interior bool) []Warning {
	warnings := make([]Warning, 0, 1+len(segments))
	if interior {
		warnings = append(warnings, Warning{Code: "experimental_hybrid_smart_cut", Message: hybridWarning(true)})
	}
	for index, segment := range segments {
		if !hasInteriorKeyframe(segment, keyframes) {
			warnings = append(warnings, Warning{Code: "hybrid_smart_cut_stream_copy_fallback", Message: fmt.Sprintf("Segment %d had no compatible interior keyframe; the requested span was stream-copied and may not be frame-exact.", index+1)})
		}
	}
	if len(warnings) == 0 {
		warnings = append(warnings, Warning{Code: hybridWarningCode(false), Message: hybridWarning(false)})
	}
	return warnings
}

func hybridWarningCode(interior bool) string {
	if interior {
		return "experimental_hybrid_smart_cut"
	}
	return "hybrid_smart_cut_stream_copy_fallback"
}

func hybridWarning(interior bool) string {
	if interior {
		return "Experimental H.264 CFR MKV hybrid cut; the leading video boundary is re-encoded, the remaining video span is stream-copied, and audio is consistently AAC-encoded. Output is not frame-exact without probe confirmation."
	}
	return "Hybrid Smart Cut found no compatible interior keyframe; the requested span was stream-copied and may not be frame-exact."
}

func hybridArgs(input string, startMS, durationMS int64, streamIndexes []int, videoCodec, audioCodec, output string) []string {
	args := []string{"-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", input, "-ss", seconds(startMS), "-t", seconds(durationMS)}
	if len(streamIndexes) == 0 {
		args = append(args, "-map", "0")
	} else {
		for _, index := range streamIndexes {
			args = append(args, "-map", fmt.Sprintf("0:%d", index))
		}
	}
	return append(args, "-avoid_negative_ts", "make_zero", "-c:v", videoCodec, "-c:a", audioCodec, output)
}

func (s Service) hybridSegment(ctx context.Context, source *os.File, segment model.Segment, output *os.File, workRoot *os.Root, workDirectory *os.File, keyframes []int64, streamIndexes []int, policy exportpolicy.Policy) (returnErr error) {
	boundary := int64(-1)
	for _, keyframe := range keyframes {
		if keyframe >= segment.StartMS {
			boundary = keyframe
			break
		}
	}
	if boundary <= segment.StartMS || boundary >= segment.EndMS {
		return s.copySegment(ctx, source, segment, output, workRoot, workDirectory, Request{CutStrategy: "stream_copy_preferred", Container: "mkv", StreamIndexes: streamIndexes}, nil, policy)
	}
	prefixName, suffixName := "prefix.mkv", "suffix.mkv"
	prefix, err := workRoot.OpenFile(prefixName, os.O_RDWR|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	defer func() {
		if err := prefix.Close(); err != nil {
			returnErr = errors.Join(returnErr, fmt.Errorf("close hybrid prefix: %w", err))
		}
		if err := workRoot.Remove(prefixName); err != nil {
			returnErr = errors.Join(returnErr, fmt.Errorf("remove hybrid prefix: %w", err))
		}
	}()
	suffix, err := workRoot.OpenFile(suffixName, os.O_RDWR|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	defer func() {
		if err := suffix.Close(); err != nil {
			returnErr = errors.Join(returnErr, fmt.Errorf("close hybrid suffix: %w", err))
		}
		if err := workRoot.Remove(suffixName); err != nil {
			returnErr = errors.Join(returnErr, fmt.Errorf("remove hybrid suffix: %w", err))
		}
	}()
	if _, err := source.Seek(0, io.SeekStart); err != nil {
		return err
	}
	prefixArgs := hybridArgs(sourceArgument(), segment.StartMS, boundary-segment.StartMS, streamIndexes, "libx264", "aac", "prefix.mkv")
	if err := s.runWithOutput(ctx, source, prefix, workDirectory, prefixArgs, policy); err != nil {
		return err
	}
	if _, err := source.Seek(0, io.SeekStart); err != nil {
		return err
	}
	suffixArgs := hybridArgs(sourceArgument(), boundary, segment.EndMS-boundary, streamIndexes, "copy", "aac", "suffix.mkv")
	if err := s.runWithOutput(ctx, source, suffix, workDirectory, suffixArgs, policy); err != nil {
		return err
	}
	return s.concatToFile(ctx, workRoot, workDirectory, []string{prefixName, suffixName}, output, policy)
}
