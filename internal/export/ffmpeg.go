package export

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"videocutlist/internal/exportpolicy"
	"videocutlist/internal/projects/model"
)

func (s Service) copySegment(ctx context.Context, source *os.File, segment model.Segment, output *os.File, workRoot *os.Root, workDirectory *os.File, request Request, keyframes []int64, policy exportpolicy.Policy) error {
	if output == nil || workRoot == nil || workDirectory == nil {
		return errors.New("segment output is not open")
	}
	if request.CutStrategy == "hybrid_smart_cut" {
		return s.hybridSegment(ctx, source, segment, output, workRoot, workDirectory, keyframes, request.StreamIndexes, policy)
	}
	if _, err := source.Seek(0, io.SeekStart); err != nil {
		return fmt.Errorf("rewind export source: %w", err)
	}
	args := []string{"-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-ss", seconds(segment.StartMS), "-i", sourceArgument(), "-t", seconds(segment.EndMS - segment.StartMS)}
	if len(request.StreamIndexes) == 0 {
		args = append(args, "-map", "0")
	} else {
		for _, index := range request.StreamIndexes {
			args = append(args, "-map", fmt.Sprintf("0:%d", index))
		}
	}
	args = append(args, "-avoid_negative_ts", "make_zero")
	if request.CutStrategy == "precise_reencode" {
		args = append(args, "-c:v", "libx264", "-c:a", "aac")
	} else {
		args = append(args, "-c", "copy")
	}
	args = append(args, output.Name())
	return s.runWithOutput(ctx, source, output, workDirectory, args, policy)
}
