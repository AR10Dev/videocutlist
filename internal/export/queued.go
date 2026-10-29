package export

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	jobs "videocutlist/internal/jobs"
	jobqueue "videocutlist/internal/jobs/model"
	librarymedia "videocutlist/internal/library/media"
)

// QueuedExecutor validates immutable export snapshots and owns terminal completion.
type QueuedExecutor struct {
	Jobs            *jobs.JobsStore
	Media           librarymedia.MediaCatalog
	RunSnapshot     func(context.Context, string, ExportSnapshot) (string, error)
	RemoveArtifacts func(string) error
}

func (e QueuedExecutor) Run(ctx context.Context, job jobqueue.Job) error {
	if e.RunSnapshot == nil || e.Media == nil {
		return errors.New("batch export runner is not configured")
	}
	var snapshot ExportSnapshot
	if err := json.Unmarshal([]byte(job.RequestJSON), &snapshot); err != nil {
		return errors.New("invalid export snapshot")
	}
	snapshot.Item.ExportOptions = snapshot.Item.ExportOptions.WithExportDefaults()
	media, err := e.Media.Get(ctx, snapshot.Source.MediaID)
	if err != nil {
		return fmt.Errorf("%w: media unavailable", jobs.ErrSourceChanged)
	}
	if err := ValidateSnapshot(snapshot, media); err != nil {
		return err
	}
	result, err := e.RunSnapshot(ctx, job.ID, snapshot)
	if err != nil {
		return err
	}
	if e.Jobs == nil {
		return errors.New("batch export job store is not configured")
	}
	// A detached, bounded CAS determines whether cancellation or success owns artifacts.
	persistCtx, persistCancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer persistCancel()
	if _, err = e.Jobs.Succeed(persistCtx, job.ID, result); err != nil {
		if errors.Is(err, jobqueue.ErrJobState) && e.RemoveArtifacts != nil {
			current, getErr := e.Jobs.Get(context.Background(), job.ID)
			if getErr == nil && current.State == jobqueue.JobCancelled {
				if removeErr := e.RemoveArtifacts(job.ID); removeErr != nil {
					err = errors.Join(err, fmt.Errorf("remove cancelled export artifacts: %w", removeErr))
				}
			}
		}
		return &jobs.ResultPersistenceError{Result: result, Err: err}
	}
	return nil
}

// ValidateSnapshot reports source_changed when current metadata differs from the queued snapshot.
func ValidateSnapshot(snapshot ExportSnapshot, media librarymedia.Media) error {
	if media.ID != snapshot.Source.MediaID || snapshot.Source.RootID != "" && media.RootID != snapshot.Source.RootID || media.ETag != snapshot.Source.ETag || media.SizeBytes != snapshot.Source.SizeBytes || media.DurationMS != snapshot.Source.DurationMS {
		return fmt.Errorf("%w", jobs.ErrSourceChanged)
	}
	return nil
}
