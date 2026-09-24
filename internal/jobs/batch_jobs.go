package jobs

import (
	"context"
	"errors"
	"fmt"
)

func (s *JobsStore) ListByBatch(ctx context.Context, batchID string) (result []Job, err error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id,batch_id,kind,COALESCE(project_id,''),COALESCE(project_item_id,''),COALESCE(proposal_id,''),COALESCE(credential_id,''),state,request_json,result_json,error_code,created_at,updated_at FROM jobs WHERE batch_id=? ORDER BY created_at,id`, batchID)
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

func (s *JobsStore) ListByProposal(ctx context.Context, proposalID string) ([]Job, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id,batch_id,kind,COALESCE(project_id,''),COALESCE(project_item_id,''),COALESCE(proposal_id,''),COALESCE(credential_id,''),state,request_json,result_json,error_code,created_at,updated_at FROM jobs WHERE proposal_id=? ORDER BY created_at,id`, proposalID)
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

func (s *JobsStore) ListBatchIDs(ctx context.Context, kind JobKind, limit int) (result []string, err error) {
	rows, err := s.db.QueryContext(ctx, `SELECT batch_id FROM jobs WHERE kind=? GROUP BY batch_id ORDER BY MAX(created_at) DESC, batch_id DESC LIMIT ?`, kind, limit)
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
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		result = append(result, id)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if closeErr := closeRows(); closeErr != nil {
		return nil, fmt.Errorf("close batch ID rows: %w", closeErr)
	}
	return result, nil
}
