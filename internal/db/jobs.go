package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"videocutlist/internal/jobs/model"
)

const jobRecordColumns = `id,batch_id,kind,COALESCE(project_id,''),COALESCE(project_item_id,''),COALESCE(proposal_id,''),COALESCE(credential_id,''),state,request_json,result_json,error_code,created_at,updated_at,revision`

// JobStorage owns job SQL and transactional admission, claiming and recovery.
type JobStorage struct {
	db *sql.DB
}

func NewJobStorage(db *sql.DB) (*JobStorage, error) {
	if db == nil {
		return nil, errors.New("job database is required")
	}
	return &JobStorage{db: db}, nil
}

func (s *JobStorage) CreateJob(ctx context.Context, job model.Job) (model.Job, error) {
	if err := model.ValidateNewJob(job); err != nil {
		return model.Job{}, err
	}
	now := time.Now().UTC()
	stamp := now.Format(time.RFC3339Nano)
	if err := insertJob(ctx, s.db, job, stamp); err != nil {
		return model.Job{}, fmt.Errorf("create job: %w", err)
	}
	return s.GetJob(ctx, job.ID)
}

func (s *JobStorage) GetJob(ctx context.Context, id string) (model.Job, error) {
	return scanJob(s.db.QueryRowContext(ctx, `SELECT `+jobRecordColumns+` FROM jobs WHERE id=?`, id))
}

func (s *JobStorage) TransitionJob(ctx context.Context, id string, from, to model.JobState, resultJSON, errorCode sql.NullString) (model.Job, error) {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	result, err := s.db.ExecContext(ctx, `UPDATE jobs SET state=?,result_json=?,error_code=?,updated_at=?,revision=revision+1 WHERE id=? AND state=?`, to, resultJSON, errorCode, now, id, from)
	if err != nil {
		return model.Job{}, err
	}
	updated, err := result.RowsAffected()
	if err != nil {
		return model.Job{}, err
	}
	if updated == 1 {
		return s.GetJob(ctx, id)
	}
	if _, err := s.GetJob(ctx, id); err != nil {
		return model.Job{}, err
	}
	return model.Job{}, model.ErrJobState
}

func (s *JobStorage) BatchJobCounts(ctx context.Context, batchID string) (model.BatchCounts, error) {
	var counts model.BatchCounts
	err := s.db.QueryRowContext(ctx, `SELECT COUNT(*), COALESCE(SUM(state IN ('succeeded','failed','cancelled')),0), COALESCE(SUM(state='running'),0), COALESCE(SUM(state='failed'),0), COALESCE(SUM(state='cancelled'),0) FROM jobs WHERE batch_id=?`, batchID).Scan(&counts.Total, &counts.Terminal, &counts.Running, &counts.Failed, &counts.Cancelled)
	return counts, err
}

func (s *JobStorage) RecoverRunningJobs(ctx context.Context) (int64, error) {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	result, err := s.db.ExecContext(ctx, `UPDATE jobs SET state=?,error_code=?,updated_at=?,revision=revision+1 WHERE state=?`, model.JobFailed, "interrupted_by_restart", now, model.JobRunning)
	if err != nil {
		return 0, err
	}
	return result.RowsAffected()
}

func (s *JobStorage) ListJobsByBatch(ctx context.Context, batchID string) ([]model.Job, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+jobRecordColumns+` FROM jobs WHERE batch_id=? ORDER BY created_at,id`, batchID)
	if err != nil {
		return nil, err
	}
	return scanJobRows(rows, "close batch job rows")
}

func (s *JobStorage) BatchCursorSnapshot(ctx context.Context, batchID string) (result []model.BatchCursorEntry, err error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id,revision,state FROM jobs WHERE batch_id=? ORDER BY id`, batchID)
	if err != nil {
		return nil, err
	}
	defer func() {
		if closeErr := rows.Close(); closeErr != nil {
			err = errors.Join(err, fmt.Errorf("close batch cursor rows: %w", closeErr))
		}
	}()
	for rows.Next() {
		var entry model.BatchCursorEntry
		if err := rows.Scan(&entry.ID, &entry.Revision, &entry.State); err != nil {
			return nil, err
		}
		result = append(result, entry)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return result, nil
}

func (s *JobStorage) ListJobsByProposal(ctx context.Context, proposalID string) ([]model.Job, error) {
	return listJobsByProposal(ctx, s.db, proposalID)
}

func listJobsByProposal(ctx context.Context, queryer jobQueryer, proposalID string) ([]model.Job, error) {
	rows, err := queryer.QueryContext(ctx, `SELECT `+jobRecordColumns+` FROM jobs WHERE proposal_id=? ORDER BY created_at,id`, proposalID)
	if err != nil {
		return nil, err
	}
	return scanJobRows(rows, "close proposal job rows")
}

func scanJobRows(rows *sql.Rows, closeOperation string) (result []model.Job, err error) {
	defer func() {
		if closeErr := rows.Close(); closeErr != nil {
			err = errors.Join(err, fmt.Errorf("%s: %w", closeOperation, closeErr))
		}
	}()
	for rows.Next() {
		job, scanErr := scanJob(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		result = append(result, job)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(result) == 0 {
		return nil, model.ErrJobNotFound
	}
	return result, nil
}

func (s *JobStorage) ListBatchIDs(ctx context.Context, kind model.JobKind, after *model.BatchPosition, limit int) (result []model.BatchPosition, err error) {
	query := `SELECT batch_id, MAX(created_at) FROM jobs WHERE kind=? GROUP BY batch_id`
	args := []any{kind}
	if after != nil {
		query += ` HAVING MAX(created_at) < ? OR (MAX(created_at) = ? AND batch_id < ?)`
		args = append(args, after.CreatedAt, after.CreatedAt, after.ID)
	}
	query += ` ORDER BY MAX(created_at) DESC, batch_id DESC LIMIT ?`
	args = append(args, limit)
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer func() {
		if closeErr := rows.Close(); closeErr != nil {
			err = errors.Join(err, fmt.Errorf("close batch ID rows: %w", closeErr))
		}
	}()
	for rows.Next() {
		var position model.BatchPosition
		if err := rows.Scan(&position.ID, &position.CreatedAt); err != nil {
			return nil, err
		}
		result = append(result, position)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return result, nil
}

func (s *JobStorage) AdmitBatch(ctx context.Context, jobs []model.Job, capacity int) (out []model.Job, err error) {
	if len(jobs) > capacity {
		return nil, model.ErrQueueFull
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer rollbackJobTransaction(tx, "rollback job admission", &err)
	if err := ensureJobCapacity(ctx, tx, len(jobs), capacity); err != nil {
		return nil, err
	}
	now := time.Now().UTC()
	stamp := now.Format(time.RFC3339Nano)
	out = make([]model.Job, len(jobs))
	for index, job := range jobs {
		if err := model.ValidateNewJob(job); err != nil {
			return nil, err
		}
		if err := insertJob(ctx, tx, job, stamp); err != nil {
			return nil, fmt.Errorf("create job: %w", err)
		}
		out[index] = queuedJob(job, now)
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return out, nil
}

func (s *JobStorage) LookupCommand(ctx context.Context, command model.CommandAdmission) (model.CommandAdmissionResult, bool, error) {
	result, err := readCommandAdmission(ctx, s.db, command)
	if errors.Is(err, sql.ErrNoRows) {
		return model.CommandAdmissionResult{}, false, nil
	}
	return result, err == nil, err
}

func (s *JobStorage) AdmitCommand(ctx context.Context, command model.CommandAdmission, jobs []model.Job, capacity int) (out model.CommandAdmissionResult, err error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return out, err
	}
	defer rollbackJobTransaction(tx, "rollback command admission", &err)

	references := make([]string, len(jobs))
	for index := range jobs {
		references[index] = jobs[index].ID
	}
	referencesJSON, err := json.Marshal(references)
	if err != nil {
		return out, err
	}
	now := time.Now().UTC()
	stamp := now.Format(time.RFC3339Nano)
	_, insertErr := tx.ExecContext(ctx, `INSERT INTO command_admissions (command_scope,idempotency_key,command_kind,command_target,payload_digest,resource_refs_json,created_at) VALUES (?,?,?,?,?,?,?)`, command.Scope, command.Key, command.Kind, command.Target, command.Digest, string(referencesJSON), stamp)
	if insertErr != nil {
		replay, replayErr := readCommandAdmission(ctx, tx, command)
		if replayErr == nil {
			if err := tx.Commit(); err != nil {
				return out, err
			}
			replay.Replayed = true
			return replay, nil
		}
		if !errors.Is(replayErr, sql.ErrNoRows) {
			return out, replayErr
		}
		return out, fmt.Errorf("record command admission: %w", insertErr)
	}
	if len(jobs) > capacity {
		return out, model.ErrQueueFull
	}
	if err := ensureJobCapacity(ctx, tx, len(jobs), capacity); err != nil {
		return out, err
	}
	out.Jobs = make([]model.Job, len(jobs))
	for index, job := range jobs {
		if err := model.ValidateNewJob(job); err != nil {
			return model.CommandAdmissionResult{}, err
		}
		if err := insertJob(ctx, tx, job, stamp); err != nil {
			return model.CommandAdmissionResult{}, fmt.Errorf("create command job: %w", err)
		}
		out.Jobs[index] = queuedJob(job, now)
	}
	if err := tx.Commit(); err != nil {
		return model.CommandAdmissionResult{}, err
	}
	return out, nil
}

func (s *JobStorage) AdmitProposal(ctx context.Context, proposalID, credentialID string, jobs []model.Job, capacity int) (out []model.Job, replayed bool, err error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, false, err
	}
	defer rollbackJobTransaction(tx, "rollback proposal admission", &err)
	var existing int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM jobs WHERE proposal_id=?`, proposalID).Scan(&existing); err != nil {
		return nil, false, err
	}
	if existing > 0 {
		out, err = listJobsByProposal(ctx, tx, proposalID)
		if err != nil {
			return nil, false, err
		}
		if err := tx.Commit(); err != nil {
			return nil, false, err
		}
		return out, true, nil
	}
	if err := ensureJobCapacity(ctx, tx, len(jobs), capacity); err != nil {
		return nil, false, err
	}
	now := time.Now().UTC()
	stamp := now.Format(time.RFC3339Nano)
	out = make([]model.Job, len(jobs))
	for index, job := range jobs {
		if err := model.ValidateProposalJob(job, proposalID, credentialID); err != nil {
			return nil, false, err
		}
		if err := insertJob(ctx, tx, job, stamp); err != nil {
			return nil, false, fmt.Errorf("create proposal job: %w", err)
		}
		out[index] = queuedJob(job, now)
	}
	if err := tx.Commit(); err != nil {
		return nil, false, err
	}
	return out, false, nil
}

func (s *JobStorage) ClaimOldestQueued(ctx context.Context) (job model.Job, err error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return model.Job{}, err
	}
	defer rollbackJobTransaction(tx, "rollback job claim", &err)
	var id string
	if err := tx.QueryRowContext(ctx, `SELECT id FROM jobs WHERE state=? ORDER BY created_at,id LIMIT 1`, model.JobQueued).Scan(&id); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return model.Job{}, model.ErrNoQueuedJob
		}
		return model.Job{}, err
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	result, err := tx.ExecContext(ctx, `UPDATE jobs SET state=?,updated_at=?,revision=revision+1 WHERE id=? AND state=?`, model.JobRunning, now, id, model.JobQueued)
	if err != nil {
		return model.Job{}, err
	}
	updated, err := result.RowsAffected()
	if err != nil {
		return model.Job{}, err
	}
	if updated != 1 {
		return model.Job{}, model.ErrNoQueuedJob
	}
	job, err = scanJob(tx.QueryRowContext(ctx, `SELECT `+jobRecordColumns+` FROM jobs WHERE id=?`, id))
	if err != nil {
		return model.Job{}, err
	}
	if err := tx.Commit(); err != nil {
		return model.Job{}, err
	}
	return job, nil
}

func (s *JobStorage) ActiveBatchMembers(ctx context.Context, batchID string) (ids []string, err error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id FROM jobs WHERE batch_id=? AND state IN ('queued','running')`, batchID)
	if err != nil {
		return nil, err
	}
	defer func() {
		if closeErr := rows.Close(); closeErr != nil {
			err = errors.Join(err, fmt.Errorf("close scheduler batch rows: %w", closeErr))
		}
	}()
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return ids, nil
}

type jobExecer interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
}

type jobQueryer interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

type jobQueryRower interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

type jobScanner interface {
	Scan(...any) error
}

func insertJob(ctx context.Context, execer jobExecer, job model.Job, stamp string) error {
	_, err := execer.ExecContext(ctx, `INSERT INTO jobs (id,batch_id,kind,project_id,project_item_id,proposal_id,credential_id,state,request_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`, job.ID, job.BatchID, job.Kind, nullableString(job.ProjectID), nullableString(job.ProjectItemID), nullableString(job.ProposalID), nullableString(job.CredentialID), model.JobQueued, job.RequestJSON, stamp, stamp)
	return err
}

func ensureJobCapacity(ctx context.Context, queryer jobQueryRower, requested, capacity int) error {
	var queued int
	if err := queryer.QueryRowContext(ctx, `SELECT COUNT(*) FROM jobs WHERE state IN ('queued','running')`).Scan(&queued); err != nil {
		return err
	}
	if queued+requested > capacity {
		return model.ErrQueueFull
	}
	return nil
}

func readCommandAdmission(ctx context.Context, queryer jobQueryRower, command model.CommandAdmission) (model.CommandAdmissionResult, error) {
	var kind, target, digest, referencesJSON string
	if err := queryer.QueryRowContext(ctx, `SELECT command_kind,command_target,payload_digest,resource_refs_json FROM command_admissions WHERE command_scope=? AND idempotency_key=?`, command.Scope, command.Key).Scan(&kind, &target, &digest, &referencesJSON); err != nil {
		return model.CommandAdmissionResult{}, err
	}
	if kind != command.Kind || target != command.Target || digest != command.Digest {
		return model.CommandAdmissionResult{}, model.ErrAdmissionConflict
	}
	var references []string
	if err := json.Unmarshal([]byte(referencesJSON), &references); err != nil || len(references) == 0 {
		return model.CommandAdmissionResult{}, errors.New("invalid stored command references")
	}
	result := model.CommandAdmissionResult{Jobs: make([]model.Job, 0, len(references))}
	for _, id := range references {
		job, err := scanJob(queryer.QueryRowContext(ctx, `SELECT `+jobRecordColumns+` FROM jobs WHERE id=?`, id))
		if err != nil {
			return model.CommandAdmissionResult{}, fmt.Errorf("load admitted command job: %w", err)
		}
		result.Jobs = append(result.Jobs, job)
	}
	return result, nil
}

func scanJob(row jobScanner) (model.Job, error) {
	var job model.Job
	var createdAt, updatedAt string
	err := row.Scan(&job.ID, &job.BatchID, &job.Kind, &job.ProjectID, &job.ProjectItemID, &job.ProposalID, &job.CredentialID, &job.State, &job.RequestJSON, &job.ResultJSON, &job.ErrorCode, &createdAt, &updatedAt, &job.Revision)
	if errors.Is(err, sql.ErrNoRows) {
		return model.Job{}, model.ErrJobNotFound
	}
	if err != nil {
		return model.Job{}, err
	}
	if job.CreatedAt, err = time.Parse(time.RFC3339Nano, createdAt); err != nil {
		return model.Job{}, err
	}
	if job.UpdatedAt, err = time.Parse(time.RFC3339Nano, updatedAt); err != nil {
		return model.Job{}, err
	}
	return job, nil
}

func queuedJob(job model.Job, now time.Time) model.Job {
	job.Revision = 1
	job.State = model.JobQueued
	job.ResultJSON = sql.NullString{}
	job.ErrorCode = sql.NullString{}
	job.CreatedAt = now
	job.UpdatedAt = now
	return job
}

func nullableString(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func rollbackJobTransaction(tx *sql.Tx, operation string, err *error) {
	if rollbackErr := tx.Rollback(); rollbackErr != nil && !errors.Is(rollbackErr, sql.ErrTxDone) {
		*err = errors.Join(*err, fmt.Errorf("%s: %w", operation, rollbackErr))
	}
}
