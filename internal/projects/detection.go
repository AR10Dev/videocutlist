package projects

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"

	store "videocutlist/internal/db"
	jobqueue "videocutlist/internal/jobs"
	"videocutlist/internal/projects/model"
)

type DetectionRequest struct {
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
type DetectionJob struct {
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
	Detect(context.Context, DetectionRequest) ([]model.Candidate, error)
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
	Projects    ProjectRepository
	UnifiedJobs *jobqueue.JobsStore
	Scheduler   *jobqueue.Scheduler
	Detector    Detector
}

func NewDetectionUseCase(d Detector) *DetectionUseCase {
	return &DetectionUseCase{Detector: d}
}
func (e *DetectionUseCase) Submit(ctx context.Context, projectID, idempotencyKey string, request DetectionRequest) (DetectionJob, error) {
	if e.Scheduler == nil || e.UnifiedJobs == nil || e.Projects == nil || e.Catalog == nil || !jobqueue.ValidCommandKey(idempotencyKey) {
		return DetectionJob{}, errors.New("detection command dependencies and valid idempotency key are required")
	}
	if err := validateDetectionSubmission(request); err != nil {
		return DetectionJob{}, err
	}
	admission, err := detectionAdmission(idempotencyKey, projectID, request)
	if err != nil {
		return DetectionJob{}, err
	}
	if replay, found, err := e.Scheduler.LookupCommand(ctx, admission); err != nil {
		return DetectionJob{}, err
	} else if found {
		return detectionJobResult(replay.Jobs[0]), nil
	}
	replayOnFailure := func(failure error) (DetectionJob, error) {
		result, found, lookupErr := e.Scheduler.LookupCommand(ctx, admission)
		if lookupErr != nil {
			return DetectionJob{}, lookupErr
		}
		if found {
			return detectionJobResult(result.Jobs[0]), nil
		}
		return DetectionJob{}, failure
	}
	project, err := e.Projects.Get(ctx, projectID)
	if err != nil {
		return replayOnFailure(err)
	}
	if project.Revision != request.ProjectRevision || !detectionProjectContains(project.Document, request.ProjectItemID, request.MediaID) {
		return replayOnFailure(store.ErrRevisionConflict)
	}
	media, err := e.Catalog.Get(ctx, request.MediaID)
	if err != nil {
		return replayOnFailure(err)
	}
	if request.SourceFingerprint != "" && request.SourceFingerprint != media.ETag {
		return replayOnFailure(jobqueue.ErrSourceChanged)
	}
	request.ProjectID = projectID
	request.CredentialID = ""
	request.SourceFingerprint = media.ETag
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
	created, err := e.Scheduler.SubmitCommand(ctx, admission, []jobqueue.Job{{ID: id, BatchID: batchID, Kind: jobqueue.JobDetect, ProjectID: projectID, ProjectItemID: request.ProjectItemID, RequestJSON: string(data)}})
	if err != nil {
		if replay, found, lookupErr := e.Scheduler.LookupCommand(ctx, admission); lookupErr == nil && found {
			return detectionJobResult(replay.Jobs[0]), nil
		}
		return DetectionJob{}, err
	}
	return detectionJobResult(created.Jobs[0]), nil
}

func validateDetectionSubmission(request DetectionRequest) error {
	if request.ProjectItemID == "" {
		return errors.New("project item is required")
	}
	return ValidateDetectionRequest(request)
}

func detectionAdmission(key, projectID string, request DetectionRequest) (jobqueue.CommandAdmission, error) {
	noiseDB := request.NoiseDB
	if noiseDB == 0 {
		noiseDB = 0
	}
	sceneThreshold := request.SceneThreshold
	if sceneThreshold == 0 {
		sceneThreshold = 0
	}
	payload, err := json.Marshal(struct {
		ProjectRevision   int64               `json:"projectRevision"`
		ProjectItemID     string              `json:"projectItemId"`
		MediaID           string              `json:"mediaId"`
		SourceFingerprint string              `json:"sourceFingerprint"`
		Kind              model.DetectionKind `json:"kind"`
		NoiseDB           float64             `json:"noiseDb"`
		MinDurationMS     int64               `json:"minDurationMs"`
		SceneThreshold    float64             `json:"sceneThreshold"`
	}{request.ProjectRevision, request.ProjectItemID, request.MediaID, request.SourceFingerprint, request.Kind, noiseDB, request.MinDurationMS, sceneThreshold})
	if err != nil {
		return jobqueue.CommandAdmission{}, err
	}
	digest := sha256.Sum256(payload)
	return jobqueue.CommandAdmission{Key: key, Scope: "detection-submit", Kind: "detection-submit", Target: projectID, Digest: hex.EncodeToString(digest[:])}, nil
}

func detectionProjectContains(document model.Document, itemID, mediaID string) bool {
	for _, item := range document.Items {
		if item.ID == itemID && item.MediaID == mediaID {
			return true
		}
	}
	return false
}

func (e *DetectionUseCase) Create(ctx context.Context, projectID string, request DetectionRequest) (DetectionJob, error) {
	if request.ProjectItemID == "" {
		return DetectionJob{}, errors.New("project item is required")
	}
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
		jobs, err := e.Scheduler.Submit(ctx, []jobqueue.Job{{ID: id, BatchID: batchID, Kind: jobqueue.JobDetect, ProjectID: projectID, ProjectItemID: request.ProjectItemID, CredentialID: request.CredentialID, RequestJSON: string(data)}})
		if err != nil {
			return DetectionJob{}, err
		}
		return detectionJobResult(jobs[0]), nil
	}
	return DetectionJob{}, errors.New("detection scheduler is not configured")
}
func detectionJobResult(j jobqueue.Job) DetectionJob {
	var request DetectionRequest
	_ = json.Unmarshal([]byte(j.RequestJSON), &request)
	projectID := request.ProjectID
	if projectID == "" {
		projectID = j.ProjectID
	}
	out := DetectionJob{ID: j.ID, Type: "detection", State: string(j.State), MediaID: request.MediaID, ProjectID: projectID, ProjectRevision: request.ProjectRevision, Kind: request.Kind}
	if j.State == jobqueue.JobSucceeded && j.ResultJSON.Valid {
		_ = json.Unmarshal([]byte(j.ResultJSON.String), &out.Candidates)
	}
	if j.ErrorCode.Valid {
		v := j.ErrorCode.String
		out.ErrorCode = &v
	}
	return out
}
