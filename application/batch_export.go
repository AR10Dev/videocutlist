package application

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"videocutlist/domain"
	"videocutlist/infrastructure/store"
)

// ExportSnapshot is the immutable, safe request stored for one batch child.
type ExportSnapshot struct {
	ProjectRevision int64                  `json:"projectRevision"`
	Item            domain.ProjectItem     `json:"item"`
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
	Jobs      *store.JobsStore
	Scheduler *store.Scheduler
	Settings  *store.RuntimeSettingsState
	// RunSnapshot executes an immutable export snapshot after source validation.
	RunSnapshot func(context.Context, ExportSnapshot) error
}

func (b BatchExportUseCase) Submit(ctx context.Context, request BatchExportRequest) (string, []Job, error) {
	if b.Projects == nil || b.Media == nil || b.Jobs == nil {

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
	jobs := make([]store.Job, 0, len(project.Document.Items))
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
		snapshot := ExportSnapshot{ProjectRevision: project.Document.Revision, Item: cloneProjectItem(item), Source: SourceSnapshot{MediaID: media.ID, ETag: media.ETag, SizeBytes: media.SizeBytes, DurationMS: media.DurationMS}, RuntimeSettings: runtimeSettings(b.Settings)}
		payload, err := json.Marshal(snapshot)
		if err != nil {
			return "", nil, err
		}
		id, err := newID("j_")
		if err != nil {
			return "", nil, err
		}
		jobs = append(jobs, store.Job{ID: id, BatchID: batchID, Kind: store.JobExport, ProjectID: request.ProjectID, ProjectItemID: item.ID, RequestJSON: string(payload)})
	}
	if len(jobs) == 0 {
		return "", nil, errors.New("no project items selected")
	}
	var created []store.Job
	if b.Scheduler != nil {
		created, err = b.Scheduler.Submit(ctx, jobs)
	} else {
		created, err = b.Jobs.CreateBatch(ctx, jobs)
	}
	if err != nil {
		return "", nil, err
	}
	result := make([]Job, 0, len(created))
	for _, job := range created {
		result = append(result, unifiedJobResult(job))
	}
	return batchID, result, nil
}

func cloneProjectItem(item domain.ProjectItem) domain.ProjectItem {
	item.Segments = append([]Segment(nil), item.Segments...)
	if item.EditorState != nil {
		state := *item.EditorState
		item.EditorState = &state
	}
	item.ExportOptions.StreamIndexes = append([]int(nil), item.ExportOptions.StreamIndexes...)
	return item
}

func (b BatchExportUseCase) Cancel(ctx context.Context, batchID string) error {
	if b.Scheduler != nil {
		return b.Scheduler.CancelBatch(ctx, batchID)
	}
	return b.Jobs.CancelBatch(ctx, batchID)
}

// RunQueuedSnapshot is the scheduler runner seam for immutable exports. It
// rechecks the source before handing the snapshot to the actual exporter.
func (b BatchExportUseCase) RunQueuedSnapshot(ctx context.Context, job store.Job) error {
	if b.RunSnapshot == nil || b.Media == nil {
		return errors.New("batch export runner is not configured")
	}
	var snapshot ExportSnapshot
	if err := json.Unmarshal([]byte(job.RequestJSON), &snapshot); err != nil {
		return errors.New("invalid export snapshot")
	}
	media, err := b.Media.Get(ctx, snapshot.Source.MediaID)
	if err != nil {
		return errors.New("source_changed")
	}
	if err := ValidateSnapshot(snapshot, media); err != nil {
		return err
	}
	return b.RunSnapshot(ctx, snapshot)
}

func (b BatchExportUseCase) Progress(ctx context.Context, batchID string) (store.JobState, float64, error) {
	return b.Jobs.Batch(ctx, batchID)
}

// ValidateSnapshot reports source_changed when current metadata differs from the queued snapshot.
func ValidateSnapshot(snapshot ExportSnapshot, media Media) error {
	if media.ID != snapshot.Source.MediaID || media.ETag != snapshot.Source.ETag || media.SizeBytes != snapshot.Source.SizeBytes || media.DurationMS != snapshot.Source.DurationMS {
		return fmt.Errorf("%w", store.ErrSourceChanged)
	}
	return nil
}
