// Package view owns stable public job projections and their observation use case.
package view

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	exporter "videocutlist/internal/export"
	"videocutlist/internal/exportpolicy"
	jobqueue "videocutlist/internal/jobs/model"
	librarymedia "videocutlist/internal/library/media"
	"videocutlist/internal/projects/model"
)

type Job struct {
	ID              string                                    `json:"id"`
	BatchID         string                                    `json:"batchId,omitempty"`
	ProjectItemID   string                                    `json:"projectItemId,omitempty"`
	MediaLabel      string                                    `json:"mediaLabel,omitempty"`
	Type            string                                    `json:"type"`
	State           string                                    `json:"state"`
	Revision        int64                                     `json:"revision"`
	Progress        float64                                   `json:"progress"`
	Result          *JobResult                                `json:"result,omitempty"`
	Warnings        []string                                  `json:"warnings,omitempty"`
	WarningDetails  []exporter.Finding                        `json:"warningDetails,omitempty"`
	Strategy        string                                    `json:"strategy,omitempty"`
	Container       string                                    `json:"container,omitempty"`
	AppliedStrategy string                                    `json:"appliedStrategy,omitempty"`
	Mode            string                                    `json:"mode,omitempty"`
	Selection       string                                    `json:"selection,omitempty"`
	SelectedStreams []int                                     `json:"selectedStreams,omitempty"`
	Verified        bool                                      `json:"verified,omitempty"`
	ErrorCode       *string                                   `json:"errorCode,omitempty"`
	CreatedAt       time.Time                                 `json:"createdAt"`
	UpdatedAt       time.Time                                 `json:"updatedAt"`
	MediaID         string                                    `json:"mediaId,omitempty"`
	ProjectID       string                                    `json:"projectId,omitempty"`
	ProjectRevision int64                                     `json:"projectRevision,omitempty"`
	Kind            model.DetectionKind                       `json:"kind,omitempty"`
	Candidates      []model.Candidate                         `json:"candidates,omitempty"`
	RootResults     map[string]librarymedia.RootLibraryStatus `json:"rootResults,omitempty"`
}

// SnapshotCursor returns a resource-scoped identifier for a persisted job revision.
func (job Job) SnapshotCursor() string { return fmt.Sprintf("%s:%d", job.ID, job.Revision) }

type AppliedStrategy struct {
	Segment    int    `json:"segment"`
	OutputName string `json:"outputName,omitempty"`
	Strategy   string `json:"strategy"`
}

type OutputFailure struct {
	Segment int    `json:"segment"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

type JobResult struct {
	Container         string            `json:"container,omitempty"`
	OutputName        string            `json:"outputName,omitempty"`
	OutputNames       []string          `json:"outputNames,omitempty"`
	OutputFailures    []OutputFailure   `json:"outputFailures,omitempty"`
	AppliedStrategies []AppliedStrategy `json:"appliedStrategies,omitempty"`
	SizeBytes         int64             `json:"sizeBytes"`
	RetainUntil       time.Time         `json:"retainUntil"`
	DestinationID     string            `json:"destinationId,omitempty"`
	DestinationKind   string            `json:"destinationKind,omitempty"`
}

type JobStore interface {
	Get(context.Context, string) (jobqueue.Job, error)
	Cancel(context.Context, string) (jobqueue.Job, error)
}

type JobUseCase struct{ Jobs JobStore }

type JobService interface {
	Get(context.Context, string) (Job, error)
	Cancel(context.Context, string) error
}

func (j JobUseCase) Get(ctx context.Context, id string) (Job, error) {
	if j.Jobs == nil {
		return Job{}, jobqueue.ErrJobNotFound
	}
	value, err := j.Jobs.Get(ctx, id)
	if err != nil {
		return Job{}, err
	}
	return FromRecord(value), nil
}
func (j JobUseCase) Cancel(ctx context.Context, id string) error {
	if j.Jobs == nil {
		return jobqueue.ErrJobNotFound
	}
	_, err := j.Jobs.Cancel(ctx, id)
	if errors.Is(err, jobqueue.ErrJobState) {
		return nil
	}
	return err
}

func stringPointer(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

func FromRecord(value jobqueue.Job) Job {
	var job Job
	switch value.Kind {
	case jobqueue.JobExport:
		job = jobResult(value)
		var snapshot exporter.ExportSnapshot
		if json.Unmarshal([]byte(value.RequestJSON), &snapshot) == nil {
			job.ProjectRevision = snapshot.ProjectRevision
			job.MediaID = snapshot.Source.MediaID
			job.MediaLabel = snapshot.MediaLabel
		}
	case jobqueue.JobDetect:
		job = detectionJobResult(value)
	case jobqueue.JobScan:
		result := librarymedia.ImportJobResult(value)
		job = Job{ID: result.ID, Type: string(value.Kind), State: result.State, Progress: result.Progress, RootResults: result.RootResults, ErrorCode: stringPointer(result.ErrorCode), CreatedAt: value.CreatedAt, UpdatedAt: value.UpdatedAt}
	}
	if job.ID == "" {
		job = Job{ID: value.ID, Type: string(value.Kind), State: string(value.State), CreatedAt: value.CreatedAt, UpdatedAt: value.UpdatedAt}
		job.Progress = jobProgress(value.State)
		if value.ErrorCode.Valid {
			job.ErrorCode = new(value.ErrorCode.String)
		}
	}
	job.BatchID = value.BatchID
	job.ProjectItemID = value.ProjectItemID
	job.Revision = value.Revision
	return job
}

func detectionJobResult(value jobqueue.Job) Job {
	var request struct {
		MediaID         string `json:"mediaId"`
		ProjectRevision int64  `json:"projectRevision"`
		Kind            string `json:"kind"`
	}
	if err := json.Unmarshal([]byte(value.RequestJSON), &request); err != nil {
		return Job{}
	}
	result := Job{ID: value.ID, Type: string(value.Kind), State: string(value.State), MediaID: request.MediaID, ProjectID: value.ProjectID, ProjectRevision: request.ProjectRevision, Kind: model.DetectionKind(request.Kind), Progress: jobProgress(value.State), CreatedAt: value.CreatedAt, UpdatedAt: value.UpdatedAt}
	if value.ResultJSON.Valid {
		_ = json.Unmarshal([]byte(value.ResultJSON.String), &result.Candidates)
	}
	if value.ErrorCode.Valid {
		result.ErrorCode = new(value.ErrorCode.String)
	}
	return result
}

func jobProgress(state jobqueue.JobState) float64 {
	switch state {
	case jobqueue.JobRunning:
		return .5
	case jobqueue.JobSucceeded, jobqueue.JobFailed, jobqueue.JobCancelled:
		return 1
	default:
		return 0
	}
}

func jobResult(record jobqueue.Job) Job {
	job := Job{ID: record.ID, Type: "export", State: string(record.State), Progress: jobProgress(record.State), CreatedAt: record.CreatedAt, UpdatedAt: record.UpdatedAt}
	type exportRequest struct {
		Mode          string `json:"mode"`
		Selection     string `json:"selection"`
		StreamIndexes []int  `json:"streamIndexes,omitempty"`
		CutStrategy   string `json:"cutStrategy"`
		Container     string `json:"container"`
	}
	var request exportRequest
	if json.Unmarshal([]byte(record.RequestJSON), &request) != nil || request.Mode == "" && request.CutStrategy == "" && request.Container == "" {
		var snapshot exporter.ExportSnapshot
		if json.Unmarshal([]byte(record.RequestJSON), &snapshot) == nil {
			request = exportRequest{
				Mode: snapshot.Item.ExportOptions.Mode, Selection: snapshot.Item.ExportOptions.Selection,
				StreamIndexes: snapshot.Item.ExportOptions.StreamIndexes, CutStrategy: snapshot.Item.ExportOptions.CutStrategy,
				Container: snapshot.Item.ExportOptions.Container,
			}
		}
	}
	options := (model.ExportOptions{Mode: request.Mode, Selection: request.Selection, CutStrategy: request.CutStrategy, Container: request.Container}).WithExportDefaults()
	job.Strategy, job.Mode, job.Selection, job.SelectedStreams, job.Container = options.CutStrategy, options.Mode, options.Selection, slices.Clone(request.StreamIndexes), options.Container
	if record.State == jobqueue.JobFailed && record.ErrorCode.Valid {
		job.ErrorCode = new(record.ErrorCode.String)
	}
	if record.State == jobqueue.JobSucceeded && record.ResultJSON.Valid {
		var result struct {
			JobResult
			AppliedStrategy string `json:"appliedStrategy"`
			Warnings        []struct {
				Code    string `json:"code"`
				Message string `json:"message"`
			} `json:"warnings"`
			Verified bool `json:"verified"`
		}
		if json.Unmarshal([]byte(record.ResultJSON.String), &result) == nil && safeOutputNames(result.OutputName, result.OutputNames) && safeOutputFailures(result.OutputFailures) && safeAppliedStrategies(result.AppliedStrategies) && safeResultContainer(result.Container, result.OutputName, result.OutputNames) && result.SizeBytes >= 0 && !result.RetainUntil.IsZero() {
			if result.Container == "" {
				result.Container = inferredOutputContainer(result.OutputName, result.OutputNames)
			}
			job.Result = &result.JobResult
			job.AppliedStrategy = result.AppliedStrategy
			job.Verified = result.Verified
			for _, warning := range result.Warnings {
				if len(job.Warnings) == 10 {
					break
				}
				if len(warning.Message) > 500 {
					warning.Message = warning.Message[:500]
				}
				job.Warnings = append(job.Warnings, warning.Message)
				job.WarningDetails = append(job.WarningDetails, exporter.Finding{Severity: "warn", Code: warning.Code, Message: warning.Message})
			}
		}
	}
	return job
}

func safeOutputNames(name string, names []string) bool {
	if name != "" {
		return len(names) == 0 && safeOutputName(name)
	}
	if len(names) == 0 || len(names) > exportpolicy.MaxOutputs {
		return false
	}
	for _, output := range names {
		if !safeOutputName(output) {
			return false
		}
	}
	return true
}

func inferredOutputContainer(name string, names []string) string {
	if name != "" {
		if policy, ok := exportpolicy.ForFilename(name); ok {
			return policy.Name
		}
	}
	for _, output := range names {
		if policy, ok := exportpolicy.ForFilename(output); ok {
			return policy.Name
		}
	}
	return ""
}

func safeResultContainer(container, name string, names []string) bool {
	if container == "" {
		return inferredOutputContainer(name, names) != ""
	}
	policy, ok := exportpolicy.For(container)
	if !ok {
		return false
	}
	outputs := names
	if name != "" {
		outputs = []string{name}
	}
	for _, output := range outputs {
		inferred, ok := exportpolicy.ForFilename(output)
		if !ok || inferred.Name != policy.Name {
			return false
		}
	}
	return true
}

func safeOutputName(name string) bool {
	if name == "" || name == "." || name == ".." || len(name) > 255 {
		return false
	}
	for _, r := range name {
		if (r < 'a' || r > 'z') && (r < 'A' || r > 'Z') && (r < '0' || r > '9') && r != '.' && r != '-' && r != '_' {
			return false
		}
	}
	return true
}

func safeOutputFailures(failures []OutputFailure) bool {
	if len(failures) > exportpolicy.MaxOutputs {
		return false
	}
	for _, failure := range failures {
		if failure.Segment < 1 || !safeOutputName(failure.Code) || failure.Code == "." || failure.Code == ".." || len(failure.Message) > 500 || strings.ContainsAny(failure.Message, "/\\") {
			return false
		}
		for _, character := range failure.Message {
			if character < 32 || character == 127 {
				return false
			}
		}
	}
	return true
}

func safeAppliedStrategies(strategies []AppliedStrategy) bool {
	for _, strategy := range strategies {
		if strategy.Segment < 1 || (strategy.OutputName != "" && !safeOutputName(strategy.OutputName)) || (strategy.Strategy != "stream_copy" && strategy.Strategy != "stream_copy_preferred" && strategy.Strategy != "precise_reencode" && strategy.Strategy != "hybrid_smart_cut") {
			return false
		}
	}
	return true
}
