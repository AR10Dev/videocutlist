package jobs

import (
	"context"
	"errors"
)

// CancelBatch requests cancellation for every queued or running child.
func (s *JobsStore) CancelBatch(ctx context.Context, batchID string) error {
	rows, err := s.db.QueryContext(ctx, `SELECT id FROM jobs WHERE batch_id=? AND state IN ('queued','running')`, batchID)
	if err != nil {
		return err
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for _, id := range ids {
		if _, err := s.Cancel(ctx, id); err != nil && !errors.Is(err, ErrJobState) {
			return err
		}
	}
	return nil
}

func (s *JobsStore) ListByBatch(ctx context.Context, batchID string) ([]Job, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id,batch_id,kind,COALESCE(project_id,''),COALESCE(project_item_id,''),state,request_json,result_json,error_code,created_at,updated_at FROM jobs WHERE batch_id=? ORDER BY created_at,id`, batchID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
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

func (s *JobsStore) ListBatchIDs(ctx context.Context, kind JobKind, limit int) ([]string, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT batch_id FROM jobs WHERE kind=? GROUP BY batch_id ORDER BY MAX(created_at) DESC, batch_id DESC LIMIT ?`, kind, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var result []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		result = append(result, id)
	}
	return result, rows.Err()
}
