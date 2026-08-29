package store

import (
	"context"
	"database/sql"
	_ "embed"
	"errors"
	"fmt"
	"time"

	"videocutlist/domain"
)

type JobState string

const (
	JobQueued    JobState = "queued"
	JobRunning   JobState = "running"
	JobSucceeded JobState = "succeeded"
	JobFailed    JobState = "failed"
	JobCancelled JobState = "cancelled"
)

var (
	ErrJobNotFound = errors.New("job not found")
	ErrJobState    = errors.New("invalid job transition")
)

//go:embed migrations/003_export_jobs.sql
var jobsMigration string

// ExportJob is a compatibility view while export execution moves to JobsStore.
type ExportJob struct {
	ID              string
	ProjectID       string
	ProjectRevision int64
	State           JobState
	RequestJSON     string
	ResultJSON      sql.NullString
	ErrorCode       sql.NullString
	CreatedAt       time.Time
	UpdatedAt       time.Time
}

type JobStore struct {
	db   *sql.DB
	jobs *JobsStore
}

func NewJobStore(db *sql.DB) (*JobStore, error) {
	jobs, err := NewJobsStore(db)
	if err != nil {
		return nil, err
	}
	return &JobStore{db: db, jobs: jobs}, nil
}
func MigrateJobs(ctx context.Context, db *sql.DB) error {
	if db == nil {
		return errors.New("job database is required")
	}
	_, err := db.ExecContext(ctx, jobsMigration)
	if err != nil {
		return err
	}
	_, err = db.ExecContext(ctx, unifiedJobsMigration)
	return err
}
func (s *JobStore) Create(ctx context.Context, job ExportJob) (ExportJob, error) {
	item, err := s.item(ctx, job.ProjectID)
	if err != nil {
		return ExportJob{}, err
	}
	_, err = s.jobs.Create(ctx, Job{ID: job.ID, BatchID: "b_" + job.ID, Kind: JobExport, ProjectID: job.ProjectID, ProjectItemID: item, RequestJSON: job.RequestJSON})
	if err != nil {
		return ExportJob{}, err
	}
	return s.Get(ctx, job.ID)
}
func (s *JobStore) Get(ctx context.Context, id string) (ExportJob, error) {
	job, err := s.jobs.Get(ctx, id)
	if err != nil {
		return ExportJob{}, err
	}
	if job.Kind != JobExport {
		return ExportJob{}, ErrJobNotFound
	}
	return exportView(job), nil
}
func (s *JobStore) Start(ctx context.Context, id string) (ExportJob, error) {
	job, err := s.jobs.Start(ctx, id)
	if err != nil {
		return ExportJob{}, err
	}
	return exportView(job), nil
}
func (s *JobStore) Succeed(ctx context.Context, id, result string) (ExportJob, error) {
	job, err := s.jobs.Succeed(ctx, id, result)
	if err != nil {
		return ExportJob{}, err
	}
	return exportView(job), nil
}
func (s *JobStore) Fail(ctx context.Context, id, code string) (ExportJob, error) {
	job, err := s.jobs.Fail(ctx, id, code)
	if err != nil {
		return ExportJob{}, err
	}
	return exportView(job), nil
}
func (s *JobStore) Cancel(ctx context.Context, id string) (ExportJob, error) {
	job, err := s.jobs.Cancel(ctx, id)
	if err != nil {
		return ExportJob{}, err
	}
	return exportView(job), nil
}
func (s *JobStore) Recover(ctx context.Context) (int64, error) { return s.jobs.Recover(ctx) }
func (s *JobStore) item(ctx context.Context, projectID string) (string, error) {
	if projectID == "" {
		return "", errors.New("project is required")
	}
	var document string
	if err := s.db.QueryRowContext(ctx, `SELECT document_json FROM projects WHERE id=?`, projectID).Scan(&document); err != nil {
		return "", fmt.Errorf("project item: %w", err)
	}
	var item sql.NullString
	if err := s.db.QueryRowContext(ctx, `SELECT json_extract(?, '$.items[0].id')`, document).Scan(&item); err != nil {
		return "", err
	}
	if !item.Valid || item.String == "" {
		return domain.StableProjectItemID(projectID), nil
	}
	return item.String, nil
}
func exportView(job Job) ExportJob {
	return ExportJob{ID: job.ID, ProjectID: job.ProjectID, State: job.State, RequestJSON: job.RequestJSON, ResultJSON: job.ResultJSON, ErrorCode: job.ErrorCode, CreatedAt: job.CreatedAt, UpdatedAt: job.UpdatedAt}
}
