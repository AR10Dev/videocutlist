package domain

import "errors"

type DetectionKind string

const (
	DetectSilence DetectionKind = "silence"
	DetectBlack   DetectionKind = "black"
	DetectScene   DetectionKind = "scene"
)

func (k DetectionKind) Valid() bool {
	return k == DetectSilence || k == DetectBlack || k == DetectScene
}

type Candidate struct {
	ID              string        `json:"id"`
	MediaID         string        `json:"mediaId"`
	ProjectID       string        `json:"projectId"`
	ProjectRevision int64         `json:"projectRevision"`
	StartMS         int64         `json:"startMs"`
	EndMS           int64         `json:"endMs"`
	Source          DetectionKind `json:"source"`
	Confidence      float64       `json:"confidence"`
}

func ValidateCandidate(c Candidate, durationMS int64, mediaID, projectID string, revision int64) error {
	if c.ID == "" || c.MediaID != mediaID || c.ProjectID != projectID || c.ProjectRevision != revision || !c.Source.Valid() {
		return errors.New("stale or invalid candidate")
	}
	if c.StartMS < 0 || c.StartMS >= c.EndMS || c.EndMS > durationMS || c.Confidence < 0 || c.Confidence > 1 {
		return errors.New("invalid candidate range")
	}
	return nil
}
