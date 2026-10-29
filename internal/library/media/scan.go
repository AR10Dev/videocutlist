package media

import (
	"context"
	"encoding/json"
	"errors"

	jobservice "videocutlist/internal/jobs"
	jobs "videocutlist/internal/jobs/model"
)

// ScanExecutor owns refresh completion and its durable result.
type ScanExecutor struct {
	Jobs    *jobservice.JobsStore
	Media   MediaService
	Catalog MediaCatalog
}

func (e ScanExecutor) Run(ctx context.Context, job jobs.Job) error {
	if e.Jobs == nil || e.Media == nil || e.Catalog == nil {
		return errors.New("media scan executor is not configured")
	}
	scanErr := e.Media.RefreshMedia(ctx)
	rootStatuses, ok := e.Catalog.(RootStatusCatalog)
	if !ok {
		return errors.New("media root status catalog is not configured")
	}
	result, err := json.Marshal(rootStatuses.RootStatuses())
	if err != nil {
		return err
	}
	if scanErr != nil {
		_, err = e.Jobs.FailWithResult(ctx, job.ID, string(result), "scan_failed")
		return errors.Join(scanErr, err)
	}
	_, err = e.Jobs.Succeed(ctx, job.ID, string(result))
	return err
}
