package projects

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"

	store "videocutlist/internal/db"
	"videocutlist/internal/detection"
	jobs "videocutlist/internal/jobs"
	jobqueue "videocutlist/internal/jobs/model"
	librarymedia "videocutlist/internal/library/media"
	"videocutlist/internal/projects/model"
)

type DetectionUseCase struct {
	Catalog     librarymedia.MediaCatalog
	Projects    ProjectRepository
	UnifiedJobs *jobs.JobsStore
	Scheduler   *jobs.Scheduler
	Detector    detection.Detector
}

func NewDetectionUseCase(d detection.Detector) *DetectionUseCase {
	return &DetectionUseCase{Detector: d}
}
func (e *DetectionUseCase) Submit(ctx context.Context, projectID, idempotencyKey string, request detection.Request) (detection.Job, error) {
	if e.Scheduler == nil || e.UnifiedJobs == nil || e.Projects == nil || e.Catalog == nil || !jobqueue.ValidCommandKey(idempotencyKey) {
		return detection.Job{}, errors.New("detection command dependencies and valid idempotency key are required")
	}
	if err := validateDetectionSubmission(request); err != nil {
		return detection.Job{}, err
	}
	admission, err := detectionAdmission(idempotencyKey, projectID, request)
	if err != nil {
		return detection.Job{}, err
	}
	if replay, found, err := e.Scheduler.LookupCommand(ctx, admission); err != nil {
		return detection.Job{}, err
	} else if found {
		return detection.AdmissionJobResult(replay.Jobs[0]), nil
	}
	replayOnFailure := func(failure error) (detection.Job, error) {
		result, found, lookupErr := e.Scheduler.LookupCommand(ctx, admission)
		if lookupErr != nil {
			return detection.Job{}, lookupErr
		}
		if found {
			return detection.AdmissionJobResult(result.Jobs[0]), nil
		}
		return detection.Job{}, failure
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
		return replayOnFailure(jobs.ErrSourceChanged)
	}
	request.ProjectID = projectID
	request.CredentialID = ""
	request.SourceFingerprint = media.ETag
	data, err := json.Marshal(request)
	if err != nil {
		return detection.Job{}, err
	}
	id, err := jobqueue.NewID("j_")
	if err != nil {
		return detection.Job{}, err
	}
	batchID, err := jobqueue.NewID("b_")
	if err != nil {
		return detection.Job{}, err
	}
	created, err := e.Scheduler.SubmitCommand(ctx, admission, []jobqueue.Job{{ID: id, BatchID: batchID, Kind: jobqueue.JobDetect, ProjectID: projectID, ProjectItemID: request.ProjectItemID, RequestJSON: string(data)}})
	if err != nil {
		if replay, found, lookupErr := e.Scheduler.LookupCommand(ctx, admission); lookupErr == nil && found {
			return detection.AdmissionJobResult(replay.Jobs[0]), nil
		}
		return detection.Job{}, err
	}
	return detection.AdmissionJobResult(created.Jobs[0]), nil
}

func validateDetectionSubmission(request detection.Request) error {
	if request.ProjectItemID == "" {
		return errors.New("project item is required")
	}
	return detection.ValidateRequest(request)
}

func detectionAdmission(key, projectID string, request detection.Request) (jobqueue.CommandAdmission, error) {
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

func (e *DetectionUseCase) Create(ctx context.Context, projectID string, request detection.Request) (detection.Job, error) {
	if request.ProjectItemID == "" {
		return detection.Job{}, errors.New("project item is required")
	}
	if err := detection.ValidateRequest(request); err != nil {
		return detection.Job{}, err
	}
	if e.Scheduler != nil && e.UnifiedJobs != nil {
		if request.SourceFingerprint == "" && e.Catalog != nil {
			media, err := e.Catalog.Get(ctx, request.MediaID)
			if err != nil {
				return detection.Job{}, err
			}
			request.SourceFingerprint = media.ETag
		}
		if request.SourceFingerprint == "" {
			return detection.Job{}, errors.New("source fingerprint is required")
		}
		request.ProjectID = projectID
		data, err := json.Marshal(request)
		if err != nil {
			return detection.Job{}, err
		}
		id, err := jobqueue.NewID("j_")
		if err != nil {
			return detection.Job{}, err
		}
		batchID, err := jobqueue.NewID("b_")
		if err != nil {
			return detection.Job{}, err
		}
		jobs, err := e.Scheduler.Submit(ctx, []jobqueue.Job{{ID: id, BatchID: batchID, Kind: jobqueue.JobDetect, ProjectID: projectID, ProjectItemID: request.ProjectItemID, CredentialID: request.CredentialID, RequestJSON: string(data)}})
		if err != nil {
			return detection.Job{}, err
		}
		return detection.AdmissionJobResult(jobs[0]), nil
	}
	return detection.Job{}, errors.New("detection scheduler is not configured")
}
