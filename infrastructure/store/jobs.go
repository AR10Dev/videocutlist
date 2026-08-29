package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"regexp"
	"time"
)

var (
	jobIDPattern   = regexp.MustCompile(`^j_[A-Za-z0-9_-]{12,64}$`)
	batchIDPattern = regexp.MustCompile(`^b_[A-Za-z0-9_-]{12,64}$`)
)

// JobKind identifies durable work. All kinds share one state machine.
type JobKind string

const (
	JobExport JobKind = "export"
	JobDetect JobKind = "detection"
	JobScan   JobKind = "library_scan"
)

// Job is the durable, transport-neutral work record. Request and Result are
// opaque JSON payloads; callers must only put safe identifiers and metadata in them.
type Job struct {
	ID, BatchID, ProjectID, ProjectItemID string
	Kind                                  JobKind
	State                                 JobState
	RequestJSON                           string
	ResultJSON, ErrorCode                 sql.NullString
	CreatedAt, UpdatedAt                  time.Time
}

type JobsStore struct{ db *sql.DB }

func NewJobsStore(db *sql.DB) (*JobsStore, error) {
	if db == nil {
		return nil, errors.New("job database is required")
	}
	return &JobsStore{db: db}, nil
}

func (s *JobsStore) Create(ctx context.Context, job Job) (Job, error) {
	if !jobIDPattern.MatchString(job.ID) || !batchIDPattern.MatchString(job.BatchID) || job.RequestJSON == "" || !validJobKind(job.Kind) {
		return Job{}, errors.New("valid job ID, batch ID, kind, and request are required")
	}
	if job.Kind != JobScan && (job.ProjectID == "" || job.ProjectItemID == "") {
		return Job{}, errors.New("project job requires project and item")
	}
	if job.Kind == JobScan && (job.ProjectID != "" || job.ProjectItemID != "") {
		return Job{}, errors.New("library scan cannot reference a project item")
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	_, err := s.db.ExecContext(ctx, `INSERT INTO jobs (id,batch_id,kind,project_id,project_item_id,state,request_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`, job.ID, job.BatchID, job.Kind, nullString(job.ProjectID), nullString(job.ProjectItemID), JobQueued, job.RequestJSON, now, now)
	if err != nil {
		return Job{}, fmt.Errorf("create job: %w", err)
	}
	return s.Get(ctx, job.ID)
}

func (s *JobsStore) CreateBatch(ctx context.Context, jobs []Job) ([]Job, error) {
	if len(jobs) == 0 {
		return nil, errors.New("batch requires jobs")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	for _, job := range jobs {
		if !jobIDPattern.MatchString(job.ID) || !batchIDPattern.MatchString(job.BatchID) || job.RequestJSON == "" || !validJobKind(job.Kind) || job.Kind != JobExport || job.ProjectID == "" || job.ProjectItemID == "" {
			return nil, errors.New("valid export jobs are required")
		}
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	for _, job := range jobs {
		if _, err := tx.ExecContext(ctx, `INSERT INTO jobs (id,batch_id,kind,project_id,project_item_id,state,request_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`, job.ID, job.BatchID, job.Kind, job.ProjectID, job.ProjectItemID, JobQueued, job.RequestJSON, now, now); err != nil {
			return nil, fmt.Errorf("create batch: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	result := make([]Job, 0, len(jobs))
	for _, job := range jobs {
		value, err := s.Get(ctx, job.ID)
		if err != nil {
			return nil, err
		}
		result = append(result, value)
	}
	return result, nil
}

func (s *JobsStore) Get(ctx context.Context, id string) (Job, error) {
	row := s.db.QueryRowContext(ctx, `SELECT id,batch_id,kind,COALESCE(project_id,''),COALESCE(project_item_id,''),state,request_json,result_json,error_code,created_at,updated_at FROM jobs WHERE id=?`, id)
	return scanUnifiedJob(row)
}

func (s *JobsStore) Cancel(ctx context.Context, id string) (Job, error) {
	job, err := s.Get(ctx, id)
	if err != nil {
		return Job{}, err
	}
	if job.State != JobQueued && job.State != JobRunning {
		return Job{}, ErrJobState
	}
	return s.transition(ctx, id, job.State, JobCancelled, sql.NullString{}, sql.NullString{})
}
func (s *JobsStore) Start(ctx context.Context, id string) (Job, error) {
	return s.transition(ctx, id, JobQueued, JobRunning, sql.NullString{}, sql.NullString{})
}
func (s *JobsStore) Succeed(ctx context.Context, id, result string) (Job, error) {
	return s.transition(ctx, id, JobRunning, JobSucceeded, sql.NullString{String: result, Valid: true}, sql.NullString{})
}
func (s *JobsStore) Fail(ctx context.Context, id, code string) (Job, error) {
	return s.transition(ctx, id, JobRunning, JobFailed, sql.NullString{}, sql.NullString{String: code, Valid: code != ""})
}

// FailWithResult records partial results before publishing a failed job.
func (s *JobsStore) FailWithResult(ctx context.Context, id, result, code string) (Job, error) {
	return s.transition(ctx, id, JobRunning, JobFailed, sql.NullString{String: result, Valid: result != ""}, sql.NullString{String: code, Valid: code != ""})
}

func (s *JobsStore) transition(ctx context.Context, id string, from, to JobState, resultJSON, errorCode sql.NullString) (Job, error) {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	r, err := s.db.ExecContext(ctx, `UPDATE jobs SET state=?,result_json=?,error_code=?,updated_at=? WHERE id=? AND state=?`, to, resultJSON, errorCode, now, id, from)
	if err != nil {
		return Job{}, err
	}
	n, err := r.RowsAffected()
	if err != nil {
		return Job{}, err
	}
	if n == 1 {
		return s.Get(ctx, id)
	}
	if _, err := s.Get(ctx, id); err != nil {
		return Job{}, err
	}
	return Job{}, ErrJobState
}

// Batch returns derived state and progress; it stores neither separately.
func (s *JobsStore) Batch(ctx context.Context, batchID string) (JobState, float64, error) {
	var total, terminal, running, failed, cancelled int
	err := s.db.QueryRowContext(ctx, `SELECT COUNT(*), SUM(state IN ('succeeded','failed','cancelled')), SUM(state='running'), SUM(state='failed'), SUM(state='cancelled') FROM jobs WHERE batch_id=?`, batchID).Scan(&total, &terminal, &running, &failed, &cancelled)
	if err != nil {
		return "", 0, err
	}
	if total == 0 {
		return "", 0, ErrJobNotFound
	}
	state := JobQueued
	if terminal == total {
		if failed > 0 {
			state = JobFailed
		} else if cancelled > 0 {
			state = JobCancelled
		} else {
			state = JobSucceeded
		}
	} else if running > 0 {
		state = JobRunning
	}
	return state, float64(terminal) / float64(total), nil
}

func (s *JobsStore) Recover(ctx context.Context) (int64, error) {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	r, err := s.db.ExecContext(ctx, `UPDATE jobs SET state=?,error_code=?,updated_at=? WHERE state=?`, JobFailed, "interrupted_by_restart", now, JobRunning)
	if err != nil {
		return 0, err
	}
	return r.RowsAffected()
}
func validJobKind(k JobKind) bool { return k == JobExport || k == JobDetect || k == JobScan }
func nullString(v string) any {
	if v == "" {
		return nil
	}
	return v
}

type unifiedJobScanner interface{ Scan(...any) error }

func scanUnifiedJob(row unifiedJobScanner) (Job, error) {
	var j Job
	var c, u string
	err := row.Scan(&j.ID, &j.BatchID, &j.Kind, &j.ProjectID, &j.ProjectItemID, &j.State, &j.RequestJSON, &j.ResultJSON, &j.ErrorCode, &c, &u)
	if errors.Is(err, sql.ErrNoRows) {
		return Job{}, ErrJobNotFound
	}
	if err != nil {
		return Job{}, err
	}
	if j.CreatedAt, err = time.Parse(time.RFC3339Nano, c); err != nil {
		return Job{}, err
	}
	if j.UpdatedAt, err = time.Parse(time.RFC3339Nano, u); err != nil {
		return Job{}, err
	}
	return j, nil
}
