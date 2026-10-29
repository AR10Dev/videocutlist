package detection

import (
	"context"
	"encoding/json"
	"errors"

	jobs "videocutlist/internal/jobs"
	jobmodel "videocutlist/internal/jobs/model"
	"videocutlist/internal/library/media"
)

type QueuedExecutor struct {
	Jobs     *jobs.JobsStore
	Catalog  media.MediaCatalog
	Detector Detector
}

func (e QueuedExecutor) Run(ctx context.Context, job jobmodel.Job) error {
	if e.Jobs == nil || e.Catalog == nil || e.Detector == nil {
		return errors.New("detection executor is not configured")
	}
	var request Request
	if err := json.Unmarshal([]byte(job.RequestJSON), &request); err != nil {
		return err
	}
	if err := ValidateRequest(request); err != nil {
		return err
	}
	item, err := e.Catalog.Get(ctx, request.MediaID)
	if err != nil {
		return err
	}
	if request.SourceFingerprint == "" || item.ETag != request.SourceFingerprint {
		return jobs.ErrSourceChanged
	}
	request.ProjectID = job.ProjectID
	candidates, err := e.Detector.Detect(ctx, request)
	if err != nil {
		return err
	}
	data, err := json.Marshal(candidates)
	if err != nil {
		return err
	}
	_, err = e.Jobs.Succeed(ctx, job.ID, string(data))
	return err
}
