package application

import (
	"context"
	"encoding/json"
	"errors"
	"sync"

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
type DetectionJobs interface {
	Create(context.Context, store.DetectionJob) (store.DetectionJob, error)
	Get(context.Context, string, string) (store.DetectionJob, error)
	Start(context.Context, string, string) (store.DetectionJob, error)
	Succeed(context.Context, string, string, string) (store.DetectionJob, error)
	Fail(context.Context, string, string, string) (store.DetectionJob, error)
	Cancel(context.Context, string, string) (store.DetectionJob, error)
}
type DetectionUseCase struct {
	Jobs    DetectionJobs
	Catalog MediaCatalog
	// UnifiedJobs and Scheduler are the durable production path. Jobs is retained
	// only for compatibility with older callers while they migrate.
	UnifiedJobs *store.JobsStore
	Scheduler   *store.Scheduler
	Detector    Detector
	slots       chan struct{}
	limit       func() int
	active      int
	mu          sync.Mutex
	cancel      map[string]context.CancelFunc
}

func NewDetectionUseCase(j DetectionJobs, d Detector, limit int) *DetectionUseCase {
	if limit < 1 {
		limit = 1
	}
	return &DetectionUseCase{Jobs: j, Detector: d, slots: make(chan struct{}, limit), cancel: map[string]context.CancelFunc{}}
}

func (e *DetectionUseCase) SetLimitProvider(provider func() int) { e.limit = provider }
func (e *DetectionUseCase) Create(ctx context.Context, p domain.Principal, projectID string, request DetectionRequest) (DetectionJob, error) {
	if request.ProjectRevision < 1 || request.MediaID == "" || !request.Kind.Valid() || (request.NoiseDB != 0 && (request.NoiseDB < -100 || request.NoiseDB > 0)) || request.MinDurationMS < 0 || request.MinDurationMS > 24*60*60*1000 || (request.SceneThreshold != 0 && (request.SceneThreshold < 0 || request.SceneThreshold > 1)) {
		return DetectionJob{}, errors.New("invalid detection request")
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
	e.mu.Lock()
	limit := cap(e.slots)
	if e.limit != nil {
		limit = e.limit()
	}
	if e.active >= limit {
		e.mu.Unlock()
		return DetectionJob{}, ErrBusy
	}
	e.active++
	e.mu.Unlock()
	id, err := newID("j_")
	if err != nil {
		e.mu.Lock()
		e.active--
		e.mu.Unlock()
		return DetectionJob{}, err
	}
	request.ProjectID = projectID
	record, err := e.Jobs.Create(ctx, store.DetectionJob{ID: id, OwnerLogin: p.Subject, ProjectID: projectID, MediaID: request.MediaID, ProjectRevision: request.ProjectRevision, Kind: string(request.Kind)})
	if err != nil {
		e.mu.Lock()
		e.active--
		e.mu.Unlock()
		return DetectionJob{}, err
	}
	jobctx, cancel := context.WithCancel(context.Background())
	e.mu.Lock()
	e.cancel[id] = cancel
	e.mu.Unlock()
	go e.run(jobctx, p.Subject, id, request)
	return detectionResult(record), nil
}
func (e *DetectionUseCase) run(ctx context.Context, owner, id string, request DetectionRequest) {
	defer func() { e.mu.Lock(); e.active--; delete(e.cancel, id); e.mu.Unlock() }()
	if _, err := e.Jobs.Start(ctx, owner, id); err != nil {
		return
	}
	candidates, err := e.Detector.Detect(ctx, request)
	if err != nil {
		if errors.Is(err, context.Canceled) {
			_, _ = e.Jobs.Cancel(context.Background(), owner, id)
		} else {
			_, _ = e.Jobs.Fail(context.Background(), owner, id, "detection_failed")
		}
		return
	}
	data, err := json.Marshal(candidates)
	if err != nil {
		_, _ = e.Jobs.Fail(context.Background(), owner, id, "result_encoding_failed")
		return
	}
	_, _ = e.Jobs.Succeed(context.Background(), owner, id, string(data))
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
	j, err := e.Jobs.Get(ctx, p.Subject, id)
	if err != nil {
		return DetectionJob{}, err
	}
	return detectionResult(j), nil
}
func (e *DetectionUseCase) Cancel(ctx context.Context, p domain.Principal, id string) error {
	if e.UnifiedJobs != nil && e.Scheduler != nil {
		_, err := e.Scheduler.Cancel(ctx, id)
		return err
	}
	j, err := e.Jobs.Get(ctx, p.Subject, id)
	if err != nil {
		return err
	}
	if j.State == store.JobQueued || j.State == store.JobRunning {
		e.mu.Lock()
		if c := e.cancel[id]; c != nil {
			c()
		}
		e.mu.Unlock()
		_, err = e.Jobs.Cancel(ctx, p.Subject, id)
		if errors.Is(err, store.ErrJobState) {
			return nil
		}
		return err
	}
	return nil
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

func detectionResult(j store.DetectionJob) DetectionJob {
	out := DetectionJob{ID: j.ID, Type: "detection", State: string(j.State), MediaID: j.MediaID, ProjectID: j.ProjectID, ProjectRevision: j.ProjectRevision, Kind: domain.DetectionKind(j.Kind)}
	if j.State == store.JobSucceeded && j.ResultJSON.Valid {
		_ = json.Unmarshal([]byte(j.ResultJSON.String), &out.Candidates)
	}
	if j.ErrorCode.Valid {
		v := j.ErrorCode.String
		out.ErrorCode = &v
	}
	return out
}
