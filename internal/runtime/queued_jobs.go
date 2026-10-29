package runtime

import (
	"context"
	"errors"

	"videocutlist/internal/detection"
	exporter "videocutlist/internal/export"
	jobs "videocutlist/internal/jobs/model"
	librarymedia "videocutlist/internal/library/media"
)

// QueuedJobs executes durable requests after the scheduler claims them.
type QueuedJobs struct {
	Exports   exporter.QueuedExecutor
	Scans     librarymedia.ScanExecutor
	Detection detection.QueuedExecutor
}

func (q QueuedJobs) Run(ctx context.Context, job jobs.Job) error {
	switch job.Kind {
	case jobs.JobExport:
		return q.Exports.Run(ctx, job)
	case jobs.JobScan:
		return q.Scans.Run(ctx, job)
	case jobs.JobDetect:
		return q.Detection.Run(ctx, job)
	default:
		return errors.New("unsupported job kind")
	}
}
