package ffmpeg

import "testing"

func TestFrameRateRejectsNonPositiveValues(t *testing.T) {
	for _, value := range []string{"0/1", "-1/1"} {
		if _, err := frameRate(value); err == nil {
			t.Fatalf("frameRate(%q) succeeded", value)
		}
	}
}
