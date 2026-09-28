package model

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestCandidateJSONMigratesHistoricalSceneRangesAndConfidence(t *testing.T) {
	var candidate Candidate
	if err := json.Unmarshal([]byte(`{"id":"c_scene","mediaId":"m_media","projectId":"p_project","projectRevision":2,"startMs":1200,"endMs":1201,"source":"scene","confidence":0.7}`), &candidate); err != nil {
		t.Fatal(err)
	}
	if candidate.PointMS == nil || *candidate.PointMS != 1200 {
		t.Fatalf("historical scene candidate = %#v", candidate)
	}
	data, err := json.Marshal(candidate)
	if err != nil {
		t.Fatal(err)
	}
	encoded := string(data)
	if !strings.Contains(encoded, `"pointMs":1200`) || strings.Contains(encoded, `"confidence"`) || strings.Contains(encoded, `"startMs"`) || strings.Contains(encoded, `"endMs"`) {
		t.Fatalf("active scene candidate payload = %s", encoded)
	}
}

func TestValidateCandidateDistinguishesRangesAndPoints(t *testing.T) {
	point := int64(1200)
	if err := ValidateCandidate(Candidate{ID: "c_scene", MediaID: "m_media", ProjectID: "p_project", ProjectRevision: 2, PointMS: &point, Source: DetectScene}, 2_000, "m_media", "p_project", 2); err != nil {
		t.Fatal(err)
	}
	if err := ValidateCandidate(Candidate{ID: "c_scene", MediaID: "m_media", ProjectID: "p_project", ProjectRevision: 2, StartMS: 1200, EndMS: 1201, Source: DetectScene}, 2_000, "m_media", "p_project", 2); err == nil {
		t.Fatal("scene range was accepted without migration")
	}
	if err := ValidateCandidate(Candidate{ID: "c_range", MediaID: "m_media", ProjectID: "p_project", ProjectRevision: 2, StartMS: 100, EndMS: 200, Source: DetectSilence}, 2_000, "m_media", "p_project", 2); err != nil {
		t.Fatal(err)
	}
}
