package jobs

import (
	"context"
	"database/sql"
	"errors"

	"videocutlist/internal/jobs/model"
)

// Persistence exposes cohesive durable job operations to the application scheduler.
// Implementations own all SQL and transactional integrity.
type Persistence interface {
	CreateJob(context.Context, model.Job) (model.Job, error)
	GetJob(context.Context, string) (model.Job, error)
	TransitionJob(context.Context, string, model.JobState, model.JobState, sql.NullString, sql.NullString) (model.Job, error)
	BatchJobCounts(context.Context, string) (model.BatchCounts, error)
	RecoverRunningJobs(context.Context) (int64, error)
	ListJobsByBatch(context.Context, string) ([]model.Job, error)
	BatchCursorSnapshot(context.Context, string) ([]model.BatchCursorEntry, error)
	ListJobsByProposal(context.Context, string) ([]model.Job, error)
	ListBatchIDs(context.Context, model.JobKind, *model.BatchPosition, int) ([]model.BatchPosition, error)
	AdmitBatch(context.Context, []model.Job, int) ([]model.Job, error)
	LookupCommand(context.Context, model.CommandAdmission) (model.CommandAdmissionResult, bool, error)
	AdmitCommand(context.Context, model.CommandAdmission, []model.Job, int) (model.CommandAdmissionResult, error)
	AdmitProposal(context.Context, string, string, []model.Job, int) ([]model.Job, bool, error)
	ClaimOldestQueued(context.Context) (model.Job, error)
	ActiveBatchMembers(context.Context, string) ([]string, error)
}

// JobsStore applies domain transition and batch-projection rules over durable storage.
type JobsStore struct {
	storage Persistence
}

func NewJobsStore(storage Persistence) (*JobsStore, error) {
	if storage == nil {
		return nil, errors.New("job storage is required")
	}
	return &JobsStore{storage: storage}, nil
}
