package application

import (
	"context"
	"encoding/json"
	"errors"
	"math"

	"videocutlist/domain"
	"videocutlist/infrastructure/store"
)

type DetectionRequest struct {
	MediaID           string               `json:"mediaId"`
	ProjectID         string               `json:"-"`
	ProjectRevision   int64                `json:"projectRevision"`
	Kind              domain.DetectionKind `json:"kind"`
	SourceFingerprint string               `json:"sourceFingerprint"`
	NoiseDB           float64              `json:"noiseDb,omitempty"`
	MinDurationMS     int64                `json:"minDurationMs,omitempty"`
	SceneThreshold    float64              `json:"sceneThreshold,omitempty"`
}
type DetectionJob struct {
	ID              string               `json:"id"`
	Type            string               `json:"type"`
	State           string               `json:"state"`
	MediaID         string               `json:"mediaId"`
	ProjectID       string               `json:"projectId"`
	ProjectRevision int64                `json:"projectRevision"`
	Kind            domain.DetectionKind `json:"kind"`
	Candidates      []domain.Candidate   `json:"candidates,omitempty"`
	ErrorCode       *string              `json:"errorCode,omitempty"`
}
type Detector interface {
	Detect(context.Context, DetectionRequest) ([]domain.Candidate, error)
}

const maxDetectionDurationMS int64 = 24 * 60 * 60 * 1000

// ValidateDetectionRequest validates detector parameters at both admission and execution.
func ValidateDetectionRequest(request DetectionRequest) error {
	if request.ProjectRevision < 1 || request.MediaID == "" || !request.Kind.Valid() ||
		math.IsNaN(request.NoiseDB) || math.IsInf(request.NoiseDB, 0) ||
		(request.NoiseDB != 0 && (request.NoiseDB < -100 || request.NoiseDB > 0)) ||
		request.MinDurationMS < 0 || request.MinDurationMS > maxDetectionDurationMS ||
		math.IsNaN(request.SceneThreshold) || math.IsInf(request.SceneThreshold, 0) ||
		(request.SceneThreshold != 0 && (request.SceneThreshold < 0 || request.SceneThreshold > 1)) {
		return errors.New("invalid detection request")
	}
	return nil
}

type DetectionUseCase struct {
	Catalog     MediaCatalog
	UnifiedJobs *store.JobsStore
	Scheduler   *store.Scheduler
	Detector    Detector
}

func NewDetectionUseCase(d Detector) *DetectionUseCase {
	return &DetectionUseCase{Detector: d}
}
func (e *DetectionUseCase) Create(ctx context.Context, p domain.Principal, projectID string, request DetectionRequest) (DetectionJob, error) {
	if err := ValidateDetectionRequest(request); err != nil {
		return DetectionJob{}, err
	}
	if e.Scheduler != nil && e.UnifiedJobs != nil {
		if request.SourceFingerprint == "" && e.Catalog != nil {
			media, err := e.Catalog.Get(ctx, request.MediaID)
			if err != nil {
				return DetectionJob{}, err
			}
			request.SourceFingerprint = media.ETag
		}
		if request.SourceFingerprint == "" {
			return DetectionJob{}, errors.New("source fingerprint is required")
		}
		request.ProjectID = projectID
		data, err := json.Marshal(request)
		if err != nil {
			return DetectionJob{}, err
		}
		id, err := newID("j_")
		if err != nil {
			return DetectionJob{}, err
		}
		batchID, err := newID("b_")
		if err != nil {
			return DetectionJob{}, err
		}
		jobs, err := e.Scheduler.Submit(ctx, []store.Job{{ID: id, BatchID: batchID, Kind: store.JobDetect, ProjectID: projectID, ProjectItemID: domain.StableProjectItemID(projectID), RequestJSON: string(data)}})
		if err != nil {
			return DetectionJob{}, err
		}
		return detectionJobResult(jobs[0]), nil
	}
	return DetectionJob{}, errors.New("detection scheduler is not configured")
}
func (e *DetectionUseCase) Get(ctx context.Context, p domain.Principal, id string) (DetectionJob, error) {
	if e.UnifiedJobs != nil {
		j, err := e.UnifiedJobs.Get(ctx, id)
		if err != nil {
			return DetectionJob{}, err
		}
		if j.Kind != store.JobDetect {
			return DetectionJob{}, store.ErrJobNotFound
		}
		return detectionJobResult(j), nil
	}
	return DetectionJob{}, store.ErrJobNotFound
}
func (e *DetectionUseCase) Cancel(ctx context.Context, p domain.Principal, id string) error {
	if e.UnifiedJobs == nil || e.Scheduler == nil {
		return store.ErrJobNotFound
	}
	_, err := e.Scheduler.Cancel(ctx, id)
	return err
}
func detectionJobResult(j store.Job) DetectionJob {
	var request DetectionRequest
	_ = json.Unmarshal([]byte(j.RequestJSON), &request)
	projectID := request.ProjectID
	if projectID == "" {
		projectID = j.ProjectID
	}
	out := DetectionJob{ID: j.ID, Type: "detection", State: string(j.State), MediaID: request.MediaID, ProjectID: projectID, ProjectRevision: request.ProjectRevision, Kind: request.Kind}
	if j.State == store.JobSucceeded && j.ResultJSON.Valid {
		_ = json.Unmarshal([]byte(j.ResultJSON.String), &out.Candidates)
	}
	if j.ErrorCode.Valid {
		v := j.ErrorCode.String
		out.ErrorCode = &v
	}
	return out
}
