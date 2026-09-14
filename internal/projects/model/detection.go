package model

import (
	"encoding/json"
	"errors"
)

type DetectionKind string

const (
	DetectSilence DetectionKind = "silence"
	DetectBlack   DetectionKind = "black"
	DetectScene   DetectionKind = "scene"
)

func (k DetectionKind) Valid() bool {
	return k == DetectSilence || k == DetectBlack || k == DetectScene
}

// Candidate is either a detected range or a scene-change point. Scene points
// are serialized with pointMs instead of the legacy one-millisecond range.
type Candidate struct {
	ID              string        `json:"id"`
	MediaID         string        `json:"mediaId"`
	ProjectID       string        `json:"projectId"`
	ProjectRevision int64         `json:"projectRevision"`
	StartMS         int64         `json:"startMs"`
	EndMS           int64         `json:"endMs"`
	PointMS         *int64        `json:"pointMs,omitempty"`
	Source          DetectionKind `json:"source"`
}

type candidateJSON struct {
	ID              string        `json:"id"`
	MediaID         string        `json:"mediaId"`
	ProjectID       string        `json:"projectId"`
	ProjectRevision int64         `json:"projectRevision"`
	StartMS         *int64        `json:"startMs,omitempty"`
	EndMS           *int64        `json:"endMs,omitempty"`
	PointMS         *int64        `json:"pointMs,omitempty"`
	Source          DetectionKind `json:"source"`
}

// MarshalJSON keeps the active contract range/point-shaped while allowing old
// persisted scene ranges to be read and rewritten as points.
func (c Candidate) MarshalJSON() ([]byte, error) {
	payload := candidateJSON{ID: c.ID, MediaID: c.MediaID, ProjectID: c.ProjectID, ProjectRevision: c.ProjectRevision, Source: c.Source}
	if c.Source == DetectScene {
		point := c.PointMS
		if point == nil && c.EndMS > c.StartMS && c.EndMS-c.StartMS == 1 {
			point = new(c.StartMS)
		}
		payload.PointMS = point
	} else {
		start, end := c.StartMS, c.EndMS
		payload.StartMS, payload.EndMS = &start, &end
	}
	return json.Marshal(payload)
}

// UnmarshalJSON accepts historical confidence fields and one-millisecond
// scene ranges without treating either as active detection evidence.
func (c *Candidate) UnmarshalJSON(data []byte) error {
	var payload candidateJSON
	if err := json.Unmarshal(data, &payload); err != nil {
		return err
	}
	*c = Candidate{ID: payload.ID, MediaID: payload.MediaID, ProjectID: payload.ProjectID, ProjectRevision: payload.ProjectRevision, Source: payload.Source}
	if payload.StartMS != nil {
		c.StartMS = *payload.StartMS
	}
	if payload.EndMS != nil {
		c.EndMS = *payload.EndMS
	}
	c.PointMS = payload.PointMS
	if c.Source == DetectScene && c.PointMS == nil && payload.StartMS != nil && payload.EndMS != nil && *payload.EndMS > *payload.StartMS && *payload.EndMS-*payload.StartMS == 1 {
		point := *payload.StartMS
		c.PointMS = &point
	}
	return nil
}

func ValidateCandidate(c Candidate, durationMS int64, mediaID, projectID string, revision int64) error {
	if c.ID == "" || c.MediaID != mediaID || c.ProjectID != projectID || c.ProjectRevision != revision || !c.Source.Valid() {
		return errors.New("stale or invalid candidate")
	}
	if c.Source == DetectScene {
		if c.PointMS == nil || *c.PointMS < 0 || *c.PointMS > durationMS {
			return errors.New("invalid candidate point")
		}
		return nil
	}
	if c.PointMS != nil || durationMS < 0 || c.StartMS < 0 || c.StartMS >= c.EndMS || c.EndMS > durationMS {
		return errors.New("invalid candidate range")
	}
	return nil
}
