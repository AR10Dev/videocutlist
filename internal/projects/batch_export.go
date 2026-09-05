package projects

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"

	"videocutlist/internal/db"
	jobqueue "videocutlist/internal/jobs"
	"videocutlist/internal/projects/model"
)

// ExportSnapshot is the immutable, safe request stored for one batch child.
type ExportSnapshot struct {
	ProjectRevision int64                  `json:"projectRevision"`
	MediaLabel      string                 `json:"mediaLabel"`
	Item            model.ProjectItem      `json:"item"`
	Source          SourceSnapshot         `json:"source"`
	RuntimeSettings *store.RuntimeSettings `json:"runtimeSettings,omitempty"`
}

type SourceSnapshot struct {
	MediaID    string `json:"mediaId"`
	ETag       string `json:"etag"`
	SizeBytes  int64  `json:"sizeBytes"`
	DurationMS int64  `json:"durationMs"`
}

type BatchExportRequest struct {
	ProjectID string
	ItemIDs   []string
}

type BatchExportUseCase struct {
	Projects  ProjectRepository
	Media     MediaCatalog
	Jobs      *jobqueue.JobsStore
	Scheduler *jobqueue.Scheduler
	Settings  *store.RuntimeSettingsState
	// RunSnapshot executes an immutable export snapshot after source validation.
	RunSnapshot   func(context.Context, string, ExportSnapshot) (string, error)
	ClearManifest func(string)
}

func (b BatchExportUseCase) Submit(ctx context.Context, request BatchExportRequest) (string, []Job, error) {
	if b.Projects == nil || b.Media == nil || b.Jobs == nil || b.Scheduler == nil {
		return "", nil, errors.New("batch export dependencies are required")
	}
	project, err := b.Projects.Get(ctx, request.ProjectID)
	if err != nil {
		return "", nil, err
	}
	selected := make(map[string]struct{}, len(request.ItemIDs))
	for _, id := range request.ItemIDs {
		selected[id] = struct{}{}
	}
	batchID, err := newID("b_")
	if err != nil {
		return "", nil, err
	}
	jobs := make([]jobqueue.Job, 0, len(project.Document.Items))
	for _, item := range project.Document.Items {
		if len(selected) > 0 {
			if _, ok := selected[item.ID]; !ok {
				continue
			}
		}
		media, err := b.Media.Get(ctx, item.MediaID)
		if err != nil {
			return "", nil, &ProjectItemError{ItemID: item.ID, Code: "media_unavailable"}
		}
		if strings.ContainsAny(item.ExportOptions.FilenameTemplate, `/\\`) {
			return "", nil, &ProjectItemError{ItemID: item.ID, Code: "invalid_filename"}
		}
		snapshot := ExportSnapshot{ProjectRevision: project.Revision, MediaLabel: media.Name, Item: cloneProjectItem(item), Source: SourceSnapshot{MediaID: media.ID, ETag: media.ETag, SizeBytes: media.SizeBytes, DurationMS: media.DurationMS}, RuntimeSettings: runtimeSettings(b.Settings)}
		payload, err := json.Marshal(snapshot)
		if err != nil {
			return "", nil, err
		}
		id, err := newID("j_")
		if err != nil {
			return "", nil, err
		}
		jobs = append(jobs, jobqueue.Job{ID: id, BatchID: batchID, Kind: jobqueue.JobExport, ProjectID: request.ProjectID, ProjectItemID: item.ID, RequestJSON: string(payload)})
	}
	if len(jobs) == 0 {
		return "", nil, errors.New("no project items selected")
	}
	created, err := b.Scheduler.Submit(ctx, jobs)
	if err != nil {
		return "", nil, err
	}
	result := make([]Job, 0, len(created))
	for _, job := range created {
		result = append(result, unifiedJobResult(job))
	}
	return batchID, result, nil
}

func cloneProjectItem(item model.ProjectItem) model.ProjectItem {
	item.Segments = slices.Clone(item.Segments)
	if item.EditorState != nil {
		state := *item.EditorState
		item.EditorState = &state
	}
	item.ExportOptions.StreamIndexes = slices.Clone(item.ExportOptions.StreamIndexes)
	return item
}

func (b BatchExportUseCase) Cancel(ctx context.Context, batchID string) error {
	if b.Scheduler == nil {
		return errors.New("batch export dependencies are required")
	}
	return b.Scheduler.CancelBatch(ctx, batchID)
}

// RunQueuedSnapshot is the scheduler runner seam for immutable exports. It
// rechecks the source before handing the snapshot to the actual exporter.
func (b BatchExportUseCase) RunQueuedSnapshot(ctx context.Context, job jobqueue.Job) error {
	if b.RunSnapshot == nil || b.Media == nil {
		return errors.New("batch export runner is not configured")
	}
	var snapshot ExportSnapshot
	if err := json.Unmarshal([]byte(job.RequestJSON), &snapshot); err != nil {
		return errors.New("invalid export snapshot")
	}
	media, err := b.Media.Get(ctx, snapshot.Source.MediaID)
	if err != nil {
		return fmt.Errorf("%w: media unavailable", jobqueue.ErrSourceChanged)
	}
	if err := ValidateSnapshot(snapshot, media); err != nil {
		return err
	}
	result, err := b.RunSnapshot(ctx, job.ID, snapshot)
	if err != nil {
		return err
	}
	if b.Jobs == nil {
		return errors.New("batch export job store is not configured")
	}
	if _, err = b.Jobs.Succeed(ctx, job.ID, result); err != nil {
		return err
	}
	if b.ClearManifest != nil {
		b.ClearManifest(job.ID)
	}
	return nil
}

func (b BatchExportUseCase) Progress(ctx context.Context, batchID string) (jobqueue.JobState, float64, error) {
	return b.Jobs.Batch(ctx, batchID)
}

func (b BatchExportUseCase) Get(ctx context.Context, batchID string) (Batch, error) {
	jobs, err := b.Jobs.ListByBatch(ctx, batchID)
	if err != nil {
		return Batch{}, err
	}
	state, progress, err := b.Jobs.Batch(ctx, batchID)
	if err != nil {
		return Batch{}, err
	}
	result := Batch{BatchID: batchID, State: string(state), Progress: progress, Jobs: make([]Job, len(jobs))}
	for i, job := range jobs {
		result.Jobs[i] = unifiedJobResult(job)
		if result.ProjectID == "" {
			result.ProjectID = job.ProjectID
			result.ProjectRevision = result.Jobs[i].ProjectRevision
		}
	}
	return result, nil
}

func (b BatchExportUseCase) List(ctx context.Context, limit int) (BatchPage, error) {
	ids, err := b.Jobs.ListBatchIDs(ctx, jobqueue.JobExport, limit)
	if err != nil {
		return BatchPage{}, err
	}
	page := BatchPage{Items: make([]Batch, 0, len(ids))}
	for _, id := range ids {
		batch, err := b.Get(ctx, id)
		if err != nil {
			return BatchPage{}, err
		}
		page.Items = append(page.Items, batch)
	}
	return page, nil
}

func (b BatchExportUseCase) Retry(ctx context.Context, jobID string) (Batch, error) {
	if b.Jobs == nil || b.Scheduler == nil {
		return Batch{}, errors.New("batch export dependencies are required")
	}
	original, err := b.Jobs.Get(ctx, jobID)
	if err != nil {
		return Batch{}, err
	}
	if original.Kind != jobqueue.JobExport || original.State != jobqueue.JobFailed {
		return Batch{}, jobqueue.ErrJobState
	}
	batchID, err := newID("b_")
	if err != nil {
		return Batch{}, err
	}
	newJobID, err := newID("j_")
	if err != nil {
		return Batch{}, err
	}
	if _, err := b.Scheduler.Submit(ctx, []jobqueue.Job{{ID: newJobID, BatchID: batchID, Kind: original.Kind, ProjectID: original.ProjectID, ProjectItemID: original.ProjectItemID, RequestJSON: original.RequestJSON}}); err != nil {
		return Batch{}, err
	}
	return b.Get(ctx, batchID)
}

// ValidateSnapshot reports source_changed when current metadata differs from the queued snapshot.
func ValidateSnapshot(snapshot ExportSnapshot, media Media) error {
	if media.ID != snapshot.Source.MediaID || media.ETag != snapshot.Source.ETag || media.SizeBytes != snapshot.Source.SizeBytes || media.DurationMS != snapshot.Source.DurationMS {
		return fmt.Errorf("%w", jobqueue.ErrSourceChanged)
	}
	return nil
}
