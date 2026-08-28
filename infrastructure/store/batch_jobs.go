package store

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
