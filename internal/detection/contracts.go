package detection

import (
	"context"
	"encoding/json"
	"errors"
	"math"

	jobqueue "videocutlist/internal/jobs/model"
	"videocutlist/internal/projects/model"
)

type Request struct {
	MediaID           string              `json:"mediaId"`
	ProjectItemID     string              `json:"projectItemId"`
	ProjectID         string              `json:"-"`
	ProjectRevision   int64               `json:"projectRevision"`
	Kind              model.DetectionKind `json:"kind"`
	SourceFingerprint string              `json:"sourceFingerprint"`
	CredentialID      string              `json:"-"`
	NoiseDB           float64             `json:"noiseDb,omitempty"`
	MinDurationMS     int64               `json:"minDurationMs,omitempty"`
	SceneThreshold    float64             `json:"sceneThreshold,omitempty"`
}

type Job struct {
	ID              string              `json:"id"`
	Type            string              `json:"type"`
	State           string              `json:"state"`
	MediaID         string              `json:"mediaId"`
	ProjectID       string              `json:"projectId"`
	ProjectRevision int64               `json:"projectRevision"`
	Kind            model.DetectionKind `json:"kind"`
	Candidates      []model.Candidate   `json:"candidates,omitempty"`
	ErrorCode       *string             `json:"errorCode,omitempty"`
}

type Detector interface {
	Detect(context.Context, Request) ([]model.Candidate, error)
}

// AdmissionJobResult projects the detection result returned by command admission.
// The public unified-job projection remains owned by projects until ticket 24.
func AdmissionJobResult(job jobqueue.Job) Job {
	var request Request
	_ = json.Unmarshal([]byte(job.RequestJSON), &request)
	projectID := request.ProjectID
	if projectID == "" {
		projectID = job.ProjectID
	}
	result := Job{
		ID: job.ID, Type: "detection", State: string(job.State),
		MediaID: request.MediaID, ProjectID: projectID,
		ProjectRevision: request.ProjectRevision, Kind: request.Kind,
	}
	if job.State == jobqueue.JobSucceeded && job.ResultJSON.Valid {
		_ = json.Unmarshal([]byte(job.ResultJSON.String), &result.Candidates)
	}
	if job.ErrorCode.Valid {
		result.ErrorCode = new(job.ErrorCode.String)
	}
	return result
}

const maxDetectionDurationMS int64 = 24 * 60 * 60 * 1000

func ValidateRequest(request Request) error {
	if request.ProjectRevision < 1 || request.MediaID == "" || !request.Kind.Valid() || math.IsNaN(request.NoiseDB) || math.IsInf(request.NoiseDB, 0) || (request.NoiseDB != 0 && (request.NoiseDB < -100 || request.NoiseDB > 0)) || request.MinDurationMS < 0 || request.MinDurationMS > maxDetectionDurationMS || math.IsNaN(request.SceneThreshold) || math.IsInf(request.SceneThreshold, 0) || (request.SceneThreshold != 0 && (request.SceneThreshold < 0 || request.SceneThreshold > 1)) {
		return errors.New("invalid detection request")
	}
	return nil
}
