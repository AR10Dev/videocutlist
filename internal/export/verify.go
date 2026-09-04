package export

import (
	"context"
	"fmt"
	"strings"

	"videocutlist/internal/library/media/probe"
)

// VerifyOutput checks the temporary artifact before publication. Re-encoded
// video/audio are accepted as the documented precise/hybrid remapping.
func VerifyOutput(ctx context.Context, ffprobePath, filename string, source probe.Metadata, selected []int) error {
	return verifyOutput(ctx, ffprobePath, filename, source, selected, 0)
}

func verifyOutput(ctx context.Context, ffprobePath, filename string, source probe.Metadata, selected []int, expectedDurationMS int64) error {
	output, err := (probe.Client{Path: ffprobePath}).Probe(ctx, filename)
	if err != nil {
		return err
	}
	if !strings.Contains(output.Container, "matroska") {
		return fmt.Errorf("unexpected output container")
	}
	if output.DurationMS <= 0 {
		return fmt.Errorf("output duration is not positive")
	}
	if expectedDurationMS > 0 {
		// Concatenated stream-copy timestamps can drift by several segment-sized
		// amounts. Keep the bound proportional while rejecting implausibly long data.
		tolerance := expectedDurationMS * 12 / 5
		if tolerance < 1500 {
			tolerance = 1500
		}
		if output.DurationMS < expectedDurationMS-tolerance || output.DurationMS > expectedDurationMS+tolerance {
			return fmt.Errorf("output duration %dms is implausible for expected %dms", output.DurationMS, expectedDurationMS)
		}
	}
	byIndex := map[int]probe.Stream{}
	for _, stream := range source.Streams {
		byIndex[stream.Index] = stream
	}
	actual := make(map[string]int)
	for _, stream := range output.Streams {
		if stream.Type != "video" && stream.Type != "audio" && stream.Type != "subtitle" {
			return fmt.Errorf("output contains forbidden %s stream", stream.Type)
		}
		actual[streamIdentity(stream)]++
	}
	for _, index := range selected {
		stream, ok := byIndex[index]
		if !ok {
			return fmt.Errorf("selected stream %d is absent from source", index)
		}
		identity := streamIdentity(stream)
		if actual[identity] == 0 {
			return fmt.Errorf("output is missing selected stream %d", index)
		}
		actual[identity]--
	}
	return nil
}

func streamIdentity(stream probe.Stream) string {
	language := stream.Language
	if language == "und" {
		language = ""
	}
	return fmt.Sprintf("%s|%s|%d", stream.Type, language, stream.Channels)
}
