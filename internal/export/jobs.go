package export

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"

	"editapp/internal/projects"
	"editapp/internal/store"
)

// Coordinator connects durable state transitions to one cancellable FFmpeg run.
type Coordinator struct {
	Jobs     *store.JobStore
	Exporter Service
}

func (c Coordinator) Execute(ctx context.Context, owner, jobID string, source *os.File, document projects.Document) (Result, error) {
	if c.Jobs == nil {
		return Result{}, errors.New("job store is required")
	}
	job, err := c.Jobs.Start(ctx, owner, jobID)
	if err != nil {
		return Result{}, err
	}
	var request Request
	if err := json.Unmarshal([]byte(job.RequestJSON), &request); err != nil {
		_, _ = c.Jobs.Fail(context.Background(), owner, jobID, "invalid_export_request")
		return Result{}, fmt.Errorf("decode export request: %w", err)
	}
	result, err := c.Exporter.Run(ctx, source, document, request)
	if err != nil {
		stateContext := context.Background() // Persist a terminal state even after request cancellation.
		if errors.Is(err, ErrCancelled) {
			_, _ = c.Jobs.Cancel(stateContext, owner, jobID)
		} else {
			_, _ = c.Jobs.Fail(stateContext, owner, jobID, "export_failed")
		}
		return Result{}, err
	}
	data, err := json.Marshal(result)
	if err != nil {
		_, _ = c.Jobs.Fail(context.Background(), owner, jobID, "result_encoding_failed")
		return Result{}, err
	}
	if _, err := c.Jobs.Succeed(context.Background(), owner, jobID, string(data)); err != nil {
		return Result{}, err
	}
	return result, nil
}
