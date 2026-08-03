package store

import (
	"context"
	"database/sql"
	_ "embed"
	"errors"
	"fmt"
	"time"
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
	ErrJobNotFound = errors.New("export job not found")
	ErrJobState    = errors.New("invalid export job transition")
)

//go:embed migrations/003_export_jobs.sql
var jobsMigration string

type ExportJob struct {
	ID              string
	OwnerLogin      string
	ProjectID       string
	ProjectRevision int64
	State           JobState
	RequestJSON     string
	ResultJSON      sql.NullString
	ErrorCode       sql.NullString
	CreatedAt       time.Time
	UpdatedAt       time.Time
}

type JobStore struct{ db *sql.DB }

func NewJobStore(db *sql.DB) (*JobStore, error) {
	if db == nil {
		return nil, errors.New("job database is required")
	}
	return &JobStore{db: db}, nil
}

// MigrateJobs applies the E01 durable export-jobs schema after projects.
func MigrateJobs(ctx context.Context, db *sql.DB) error {
	if db == nil {
		return errors.New("job database is required")
	}
	_, err := db.ExecContext(ctx, jobsMigration)
	return err
}

func (s *JobStore) Create(ctx context.Context, job ExportJob) (ExportJob, error) {
	if job.ID == "" || job.OwnerLogin == "" || job.ProjectID == "" || job.ProjectRevision <= 0 || job.RequestJSON == "" {
		return ExportJob{}, errors.New("job id, owner, project, revision, and request are required")
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	_, err := s.db.ExecContext(ctx, `INSERT INTO export_jobs
(id, owner_login, project_id, project_revision, state, request_json, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, job.ID, job.OwnerLogin, job.ProjectID, job.ProjectRevision, JobQueued, job.RequestJSON, now, now)
	if err != nil {
		return ExportJob{}, fmt.Errorf("create export job: %w", err)
	}
	return s.Get(ctx, job.OwnerLogin, job.ID)
}

func (s *JobStore) Get(ctx context.Context, owner, id string) (ExportJob, error) {
	row := s.db.QueryRowContext(ctx, `SELECT id, owner_login, project_id, project_revision, state, request_json, result_json, error_code, created_at, updated_at
FROM export_jobs WHERE id = ? AND owner_login = ?`, id, owner)
	job, err := scanJob(row)
	if errors.Is(err, sql.ErrNoRows) {
		return ExportJob{}, ErrJobNotFound
	}
	return job, err
}

func (s *JobStore) Start(ctx context.Context, owner, id string) (ExportJob, error) {
	return s.transition(ctx, owner, id, JobQueued, JobRunning, sql.NullString{}, sql.NullString{})
}

func (s *JobStore) Succeed(ctx context.Context, owner, id, resultJSON string) (ExportJob, error) {
	return s.transition(ctx, owner, id, JobRunning, JobSucceeded, sql.NullString{String: resultJSON, Valid: true}, sql.NullString{})
}

func (s *JobStore) Fail(ctx context.Context, owner, id, code string) (ExportJob, error) {
	return s.transition(ctx, owner, id, JobRunning, JobFailed, sql.NullString{}, sql.NullString{String: code, Valid: code != ""})
}

func (s *JobStore) Cancel(ctx context.Context, owner, id string) (ExportJob, error) {
	job, err := s.Get(ctx, owner, id)
	if err != nil {
		return ExportJob{}, err
	}
	if job.State == JobQueued {
		return s.transition(ctx, owner, id, JobQueued, JobCancelled, sql.NullString{}, sql.NullString{})
	}
	if job.State == JobRunning {
		return s.transition(ctx, owner, id, JobRunning, JobCancelled, sql.NullString{}, sql.NullString{})
	}
	return ExportJob{}, ErrJobState
}

// Recover records the only safe result for an OS process interrupted by restart.
func (s *JobStore) Recover(ctx context.Context) (int64, error) {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	result, err := s.db.ExecContext(ctx, `UPDATE export_jobs SET state = ?, error_code = ?, updated_at = ? WHERE state IN (?, ?)`, JobFailed, "interrupted_by_restart", now, JobQueued, JobRunning)
	if err != nil {
		return 0, err
	}
	return result.RowsAffected()
}

func (s *JobStore) transition(ctx context.Context, owner, id string, from, to JobState, resultJSON, errorCode sql.NullString) (ExportJob, error) {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	result, err := s.db.ExecContext(ctx, `UPDATE export_jobs SET state = ?, result_json = ?, error_code = ?, updated_at = ?
WHERE id = ? AND owner_login = ? AND state = ?`, to, resultJSON, errorCode, now, id, owner, from)
	if err != nil {
		return ExportJob{}, err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return ExportJob{}, err
	}
	if affected == 1 {
		return s.Get(ctx, owner, id)
	}
	if _, err := s.Get(ctx, owner, id); err != nil {
		return ExportJob{}, err
	}
	return ExportJob{}, ErrJobState
}

type jobScanner interface{ Scan(...any) error }

func scanJob(row jobScanner) (ExportJob, error) {
	var job ExportJob
	var created, updated string
	if err := row.Scan(&job.ID, &job.OwnerLogin, &job.ProjectID, &job.ProjectRevision, &job.State, &job.RequestJSON, &job.ResultJSON, &job.ErrorCode, &created, &updated); err != nil {
		return ExportJob{}, err
	}
	var err error
	if job.CreatedAt, err = time.Parse(time.RFC3339Nano, created); err != nil {
		return ExportJob{}, err
	}
	if job.UpdatedAt, err = time.Parse(time.RFC3339Nano, updated); err != nil {
		return ExportJob{}, err
	}
	return job, nil
}
