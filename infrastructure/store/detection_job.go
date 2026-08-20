package store

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

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
	return err
}

type DetectionJobStore struct{ db *sql.DB }

func NewDetectionJobStore(db *sql.DB) (*DetectionJobStore, error) {
	if db == nil {
		return nil, errors.New("detection job database is required")
	}
	return &DetectionJobStore{db}, nil
}
func (s *DetectionJobStore) Create(ctx context.Context, j DetectionJob) (DetectionJob, error) {
	if j.ID == "" || j.OwnerLogin == "" || j.ProjectID == "" || j.MediaID == "" || j.ProjectRevision <= 0 {
		return DetectionJob{}, errors.New("detection job fields are required")
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	_, err := s.db.ExecContext(ctx, `INSERT INTO detection_jobs(id,owner_login,project_id,media_id,project_revision,kind,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?, ?,?)`, j.ID, j.OwnerLogin, j.ProjectID, j.MediaID, j.ProjectRevision, j.Kind, JobQueued, now, now)
	if err != nil {
		return DetectionJob{}, err
	}
	return s.Get(ctx, j.OwnerLogin, j.ID)
}
func (s *DetectionJobStore) Get(ctx context.Context, owner, id string) (DetectionJob, error) {
	row := s.db.QueryRowContext(ctx, `SELECT id,owner_login,project_id,media_id,project_revision,kind,state,result_json,error_code,created_at,updated_at FROM detection_jobs WHERE id=? AND owner_login=?`, id, owner)
	var j DetectionJob
	var c, u string
	err := row.Scan(&j.ID, &j.OwnerLogin, &j.ProjectID, &j.MediaID, &j.ProjectRevision, &j.Kind, &j.State, &j.ResultJSON, &j.ErrorCode, &c, &u)
	if errors.Is(err, sql.ErrNoRows) {
		return DetectionJob{}, ErrJobNotFound
	}
	if err != nil {
		return DetectionJob{}, err
	}
	j.CreatedAt, err = time.Parse(time.RFC3339Nano, c)
	if err != nil {
		return DetectionJob{}, err
	}
	j.UpdatedAt, err = time.Parse(time.RFC3339Nano, u)
	if err != nil {
		return DetectionJob{}, err
	}
	return j, nil
}
func (s *DetectionJobStore) transition(ctx context.Context, owner, id string, from, to JobState, result, errorCode sql.NullString) (DetectionJob, error) {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	r, e := s.db.ExecContext(ctx, `UPDATE detection_jobs SET state=?,result_json=?,error_code=?,updated_at=? WHERE id=? AND owner_login=? AND state=?`, to, result, errorCode, now, id, owner, from)
	if e != nil {
		return DetectionJob{}, e
	}
	n, _ := r.RowsAffected()
	if n == 1 {
		return s.Get(ctx, owner, id)
	}
	if _, e = s.Get(ctx, owner, id); e != nil {
		return DetectionJob{}, e
	}
	return DetectionJob{}, ErrJobState
}
func (s *DetectionJobStore) Start(ctx context.Context, o, id string) (DetectionJob, error) {
	return s.transition(ctx, o, id, JobQueued, JobRunning, sql.NullString{}, sql.NullString{})
}
func (s *DetectionJobStore) Succeed(ctx context.Context, o, id, result string) (DetectionJob, error) {
	return s.transition(ctx, o, id, JobRunning, JobSucceeded, sql.NullString{String: result, Valid: true}, sql.NullString{})
}
func (s *DetectionJobStore) Fail(ctx context.Context, o, id, code string) (DetectionJob, error) {
	return s.transition(ctx, o, id, JobRunning, JobFailed, sql.NullString{}, sql.NullString{String: code, Valid: true})
}
func (s *DetectionJobStore) Cancel(ctx context.Context, o, id string) (DetectionJob, error) {
	j, e := s.Get(ctx, o, id)
	if e != nil {
		return DetectionJob{}, e
	}
	if j.State == JobQueued {
		return s.transition(ctx, o, id, JobQueued, JobCancelled, sql.NullString{}, sql.NullString{})
	}
	if j.State == JobRunning {
		return s.transition(ctx, o, id, JobRunning, JobCancelled, sql.NullString{}, sql.NullString{})
	}
	return DetectionJob{}, ErrJobState
}
