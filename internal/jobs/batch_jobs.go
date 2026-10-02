package jobs

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
)

func (s *JobsStore) ListByBatch(ctx context.Context, batchID string) (result []Job, err error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id,batch_id,kind,COALESCE(project_id,''),COALESCE(project_item_id,''),COALESCE(proposal_id,''),COALESCE(credential_id,''),state,request_json,result_json,error_code,created_at,updated_at,revision FROM jobs WHERE batch_id=? ORDER BY created_at,id`, batchID)
	if err != nil {
		return nil, err
	}
	rowsClosed := false
	closeRows := func() error {
		if rowsClosed {
			return nil
		}
		rowsClosed = true
		return rows.Close()
	}
	defer func() {
		if closeErr := closeRows(); closeErr != nil {
			err = errors.Join(err, fmt.Errorf("close batch job rows: %w", closeErr))
		}
	}()
	for rows.Next() {
		job, scanErr := scanUnifiedJob(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		result = append(result, job)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if closeErr := closeRows(); closeErr != nil {
		return nil, fmt.Errorf("close batch job rows: %w", closeErr)
	}
	if len(result) == 0 {
		return nil, ErrJobNotFound
	}
	return result, nil
}

// BatchCursor is a deterministic, resource-scoped digest of sorted child IDs,
// revisions, and states. It identifies a snapshot, not an event history.
func (s *JobsStore) BatchCursor(ctx context.Context, batchID string) (string, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id,revision,state FROM jobs WHERE batch_id=? ORDER BY id`, batchID)
	if err != nil {
		return "", err
	}
	defer func() { _ = rows.Close() }()
	hash := sha256.New()
	_, _ = fmt.Fprintf(hash, "%s\x00", batchID)
	var count int
	for rows.Next() {
		var id string
		var revision int64
		var state JobState
		if err := rows.Scan(&id, &revision, &state); err != nil {
			return "", err
		}
		_, _ = fmt.Fprintf(hash, "%s\x00%d\x00%s\x00", id, revision, state)
		count++
	}
	if err := rows.Err(); err != nil {
		return "", err
	}
	if count == 0 {
		return "", ErrJobNotFound
	}
	return "b2_" + hex.EncodeToString(hash.Sum(nil)), nil
}

func (s *JobsStore) ListByProposal(ctx context.Context, proposalID string) ([]Job, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id,batch_id,kind,COALESCE(project_id,''),COALESCE(project_item_id,''),COALESCE(proposal_id,''),COALESCE(credential_id,''),state,request_json,result_json,error_code,created_at,updated_at,revision FROM jobs WHERE proposal_id=? ORDER BY created_at,id`, proposalID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var result []Job
	for rows.Next() {
		job, err := scanUnifiedJob(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, job)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(result) == 0 {
		return nil, ErrJobNotFound
	}
	return result, nil
}

type BatchPosition struct {
	ID        string
	CreatedAt string
}

func (s *JobsStore) ListBatchIDs(ctx context.Context, kind JobKind, after *BatchPosition, limit int) (result []BatchPosition, err error) {
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
	rowsClosed := false
	closeRows := func() error {
		if rowsClosed {
			return nil
		}
		rowsClosed = true
		return rows.Close()
	}
	defer func() {
		if closeErr := closeRows(); closeErr != nil {
			err = errors.Join(err, fmt.Errorf("close batch ID rows: %w", closeErr))
		}
	}()
	for rows.Next() {
		var position BatchPosition
		if err := rows.Scan(&position.ID, &position.CreatedAt); err != nil {
			return nil, err
		}
		result = append(result, position)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if closeErr := closeRows(); closeErr != nil {
		return nil, fmt.Errorf("close batch ID rows: %w", closeErr)
	}
	return result, nil
}
