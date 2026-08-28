package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

// DetectionJob is a compatibility view while detection execution moves to JobsStore.
type DetectionJob struct {
	ID, OwnerLogin, ProjectID, MediaID string
	ProjectRevision                    int64
	Kind                               string
	State                              JobState
	ResultJSON, ErrorCode              sql.NullString
	CreatedAt, UpdatedAt               time.Time
}

func MigrateDetectionJobs(ctx context.Context, db *sql.DB) error {
	if db == nil {
		return errors.New("detection job database is required")
	}
	_, err := db.ExecContext(ctx, detectionJobsMigration)
	if err != nil {
		return err
	}
	_, err = db.ExecContext(ctx, unifiedJobsMigration)
	return err
}

type DetectionJobStore struct {
	db   *sql.DB
	jobs *JobsStore
}

func NewDetectionJobStore(db *sql.DB) (*DetectionJobStore, error) {
	jobs, err := NewJobsStore(db)
	if err != nil {
		return nil, err
	}
	return &DetectionJobStore{db: db, jobs: jobs}, nil
}
func (s *DetectionJobStore) Create(ctx context.Context, j DetectionJob) (DetectionJob, error) {
	if j.ID == "" || j.ProjectID == "" || j.MediaID == "" || j.ProjectRevision < 1 {
		return DetectionJob{}, errors.New("detection job id, project, media, and revision are required")
	}
	item, err := (&JobStore{db: s.db}).item(ctx, j.ProjectID)
	if err != nil {
		return DetectionJob{}, err
	}
	request, err := json.Marshal(map[string]string{"mediaId": j.MediaID, "kind": j.Kind})
	if err != nil {
		return DetectionJob{}, err
	}
	_, err = s.jobs.Create(ctx, Job{ID: j.ID, BatchID: "b_" + j.ID, Kind: JobDetect, ProjectID: j.ProjectID, ProjectItemID: item, RequestJSON: string(request)})
	if err != nil {
		return DetectionJob{}, err
	}
	return s.Get(ctx, "", j.ID)
}
func (s *DetectionJobStore) Get(ctx context.Context, _, id string) (DetectionJob, error) {
	job, err := s.jobs.Get(ctx, id)
	if err != nil {
		return DetectionJob{}, err
	}
	if job.Kind != JobDetect {
		return DetectionJob{}, ErrJobNotFound
	}
	return detectionView(job)
}
func (s *DetectionJobStore) Start(ctx context.Context, _, id string) (DetectionJob, error) {
	j, e := s.jobs.Start(ctx, id)
	if e != nil {
		return DetectionJob{}, e
	}
	return detectionView(j)
}
func (s *DetectionJobStore) Succeed(ctx context.Context, _, id, result string) (DetectionJob, error) {
	j, e := s.jobs.Succeed(ctx, id, result)
	if e != nil {
		return DetectionJob{}, e
	}
	return detectionView(j)
}
func (s *DetectionJobStore) Fail(ctx context.Context, _, id, code string) (DetectionJob, error) {
	j, e := s.jobs.Fail(ctx, id, code)
	if e != nil {
		return DetectionJob{}, e
	}
	return detectionView(j)
}
func (s *DetectionJobStore) Cancel(ctx context.Context, _, id string) (DetectionJob, error) {
	j, e := s.jobs.Cancel(ctx, id)
	if e != nil {
		return DetectionJob{}, e
	}
	return detectionView(j)
}
func detectionView(job Job) (DetectionJob, error) {
	var request struct {
		MediaID string `json:"mediaId"`
		Kind    string `json:"kind"`
	}
	if err := json.Unmarshal([]byte(job.RequestJSON), &request); err != nil {
		return DetectionJob{}, fmt.Errorf("decode detection request: %w", err)
	}
	return DetectionJob{ID: job.ID, ProjectID: job.ProjectID, MediaID: request.MediaID, Kind: request.Kind, State: job.State, ResultJSON: job.ResultJSON, ErrorCode: job.ErrorCode, CreatedAt: job.CreatedAt, UpdatedAt: job.UpdatedAt}, nil
}
