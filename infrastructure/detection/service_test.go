package detection

import (
	"testing"

	"videocutlist/application"
	"videocutlist/domain"
)

func TestParseDetectionCandidatesAreBounded(t *testing.T) {
	r := application.DetectionRequest{MediaID: "m_test", ProjectID: "p_test", ProjectRevision: 2, Kind: domain.DetectSilence}
	got := parse(r, 10000, "[silencedetect] silence_start: 1.2\n[silencedetect] silence_end: 2.5\n")
	if len(got) != 1 || got[0].StartMS != 1200 || got[0].EndMS != 2500 || got[0].ProjectID != r.ProjectID || got[0].Confidence != .9 {
		t.Fatalf("unexpected candidates: %#v", got)
	}
}

func TestParseRejectsUnmatchedAndClampsDuration(t *testing.T) {
	r := application.DetectionRequest{MediaID: "m_test", ProjectID: "p_test", ProjectRevision: 2, Kind: domain.DetectSilence}
	got := parse(r, 1000, "silence_end: 0.5\nsilence_start: 0.8\nsilence_end: 2.0\n")
	if len(got) != 1 || got[0].StartMS != 800 || got[0].EndMS != 1000 {
		t.Fatalf("unexpected bounded candidates: %#v", got)
	}
}
