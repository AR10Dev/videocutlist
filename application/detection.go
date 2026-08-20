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
	MediaID         string               `json:"mediaId"`
	ProjectID       string               `json:"-"`
	ProjectRevision int64                `json:"projectRevision"`
	Kind            domain.DetectionKind `json:"kind"`
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
	Jobs     DetectionJobs
	Detector Detector
	slots    chan struct{}
	mu       sync.Mutex
	cancel   map[string]context.CancelFunc
}

func NewDetectionUseCase(j DetectionJobs, d Detector, limit int) *DetectionUseCase {
	if limit < 1 {
		limit = 1
	}
	return &DetectionUseCase{Jobs: j, Detector: d, slots: make(chan struct{}, limit), cancel: map[string]context.CancelFunc{}}
}
func (e *DetectionUseCase) Create(ctx context.Context, p domain.Principal, projectID string, request DetectionRequest) (DetectionJob, error) {
	if request.ProjectRevision < 1 || request.MediaID == "" || !request.Kind.Valid() {
		return DetectionJob{}, errors.New("invalid detection request")
	}
	select {
	case e.slots <- struct{}{}:
	default:
		return DetectionJob{}, ErrBusy
	}
	id, err := newID("j_")
	if err != nil {
		<-e.slots
		return DetectionJob{}, err
	}
	request.ProjectID = projectID
	record, err := e.Jobs.Create(ctx, store.DetectionJob{ID: id, OwnerLogin: p.Subject, ProjectID: projectID, MediaID: request.MediaID, ProjectRevision: request.ProjectRevision, Kind: string(request.Kind)})
	if err != nil {
		<-e.slots
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
	defer func() { <-e.slots; e.mu.Lock(); delete(e.cancel, id); e.mu.Unlock() }()
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
	j, err := e.Jobs.Get(ctx, p.Subject, id)
	if err != nil {
		return DetectionJob{}, err
	}
	return detectionResult(j), nil
}
func (e *DetectionUseCase) Cancel(ctx context.Context, p domain.Principal, id string) error {
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
