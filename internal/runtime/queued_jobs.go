package runtime

import (
	"context"
	"encoding/json"
	"errors"

	"videocutlist/internal/jobs"
	"videocutlist/internal/projects"
)

// QueuedJobs executes durable requests after the scheduler claims them.
type QueuedJobs struct {
	Jobs      *jobs.JobsStore
	Exports   *projects.BatchExportUseCase
	Media     *projects.MediaUseCase
	Detection *projects.DetectionUseCase
	Catalog   MediaCatalog
}

func (q QueuedJobs) Run(ctx context.Context, job jobs.Job) error {
	switch job.Kind {
	case jobs.JobExport:
		return q.Exports.RunQueuedSnapshot(ctx, job)
	case jobs.JobScan:
		scanErr := q.Media.RefreshMedia(ctx)
		result, err := json.Marshal(q.Catalog.RootStatuses())
		if err != nil {
			return err
		}
		if scanErr != nil {
			_, err = q.Jobs.FailWithResult(ctx, job.ID, string(result), "scan_failed")
			return errors.Join(scanErr, err)
		}
		_, err = q.Jobs.Succeed(ctx, job.ID, string(result))
		return err
	case jobs.JobDetect:
		var request projects.DetectionRequest
		if err := json.Unmarshal([]byte(job.RequestJSON), &request); err != nil {
			return err
		}
		if err := projects.ValidateDetectionRequest(request); err != nil {
			return err
		}
		media, err := q.Catalog.Get(ctx, request.MediaID)
		if err != nil {
			return err
		}
		if request.SourceFingerprint == "" || media.ETag != request.SourceFingerprint {
			return jobs.ErrSourceChanged
		}
		request.ProjectID = job.ProjectID
		candidates, err := q.Detection.Detector.Detect(ctx, request)
		if err != nil {
			return err
		}
		data, err := json.Marshal(candidates)
		if err != nil {
			return err
		}
		_, err = q.Jobs.Succeed(ctx, job.ID, string(data))
		return err
	default:
		return errors.New("unsupported job kind")
	}
}
