// Package jobs owns durable background work decisions and state transitions.
package jobs

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"fmt"
	"hash"

	"videocutlist/internal/jobs/model"
)

func (s *JobsStore) Create(ctx context.Context, job model.Job) (model.Job, error) {
	if err := model.ValidateNewJob(job); err != nil {
		return model.Job{}, err
	}
	return s.storage.CreateJob(ctx, job)
}

func (s *JobsStore) Get(ctx context.Context, id string) (model.Job, error) {
	return s.storage.GetJob(ctx, id)
}

func (s *JobsStore) Cancel(ctx context.Context, id string) (model.Job, error) {
	job, err := s.Get(ctx, id)
	if err != nil {
		return model.Job{}, err
	}
	if job.State != model.JobQueued && job.State != model.JobRunning {
		if isTerminal(job.State) {
			return job, nil
		}
		return model.Job{}, model.ErrJobState
	}
	return s.transition(ctx, id, job.State, model.JobCancelled, emptyString(), emptyString())
}

func isTerminal(state model.JobState) bool {
	return state == model.JobSucceeded || state == model.JobFailed || state == model.JobCancelled
}

func (s *JobsStore) Start(ctx context.Context, id string) (model.Job, error) {
	return s.transition(ctx, id, model.JobQueued, model.JobRunning, emptyString(), emptyString())
}

func (s *JobsStore) Succeed(ctx context.Context, id, result string) (model.Job, error) {
	return s.transition(ctx, id, model.JobRunning, model.JobSucceeded, presentString(result), emptyString())
}

func (s *JobsStore) Fail(ctx context.Context, id, code string) (model.Job, error) {
	return s.transition(ctx, id, model.JobRunning, model.JobFailed, emptyString(), optionalString(code))
}

// FailWithResult records partial results before publishing a failed job.
func (s *JobsStore) FailWithResult(ctx context.Context, id, result, code string) (model.Job, error) {
	return s.transition(ctx, id, model.JobRunning, model.JobFailed, optionalString(result), optionalString(code))
}

func (s *JobsStore) transition(ctx context.Context, id string, from, to model.JobState, resultJSON, errorCode sql.NullString) (model.Job, error) {
	return s.storage.TransitionJob(ctx, id, from, to, resultJSON, errorCode)
}

// Batch returns the domain-derived state and progress; storage owns only the counts.
func (s *JobsStore) Batch(ctx context.Context, batchID string) (model.JobState, float64, error) {
	counts, err := s.storage.BatchJobCounts(ctx, batchID)
	if err != nil {
		return "", 0, err
	}
	if counts.Total == 0 {
		return "", 0, model.ErrJobNotFound
	}
	state := model.JobQueued
	if counts.Terminal == counts.Total {
		if counts.Failed > 0 {
			state = model.JobFailed
		} else if counts.Cancelled > 0 {
			state = model.JobCancelled
		} else {
			state = model.JobSucceeded
		}
	} else if counts.Running > 0 {
		state = model.JobRunning
	}
	return state, float64(counts.Terminal) / float64(counts.Total), nil
}

func (s *JobsStore) Recover(ctx context.Context) (int64, error) {
	return s.storage.RecoverRunningJobs(ctx)
}

func (s *JobsStore) ListByBatch(ctx context.Context, batchID string) ([]model.Job, error) {
	return s.storage.ListJobsByBatch(ctx, batchID)
}

// BatchCursor returns a deterministic digest of the ordered child snapshot.
// It identifies a snapshot, not an event history.
func (s *JobsStore) BatchCursor(ctx context.Context, batchID string) (string, error) {
	entries, err := s.storage.BatchCursorSnapshot(ctx, batchID)
	if err != nil {
		return "", err
	}
	if len(entries) == 0 {
		return "", model.ErrJobNotFound
	}
	hash := sha256.New()
	writeBatchCursor(hash, batchID, entries)
	return "b2_" + hex.EncodeToString(hash.Sum(nil)), nil
}

func writeBatchCursor(hash hash.Hash, batchID string, entries []model.BatchCursorEntry) {
	_, _ = fmt.Fprintf(hash, "%s\x00", batchID)
	for _, entry := range entries {
		_, _ = fmt.Fprintf(hash, "%s\x00%d\x00%s\x00", entry.ID, entry.Revision, entry.State)
	}
}

func (s *JobsStore) ListByProposal(ctx context.Context, proposalID string) ([]model.Job, error) {
	return s.storage.ListJobsByProposal(ctx, proposalID)
}

func (s *JobsStore) ListBatchIDs(ctx context.Context, kind model.JobKind, after *model.BatchPosition, limit int) ([]model.BatchPosition, error) {
	return s.storage.ListBatchIDs(ctx, kind, after, limit)
}

func emptyString() sql.NullString { return sql.NullString{} }

func presentString(value string) sql.NullString {
	return sql.NullString{String: value, Valid: true}
}

func optionalString(value string) sql.NullString {
	return sql.NullString{String: value, Valid: value != ""}
}
