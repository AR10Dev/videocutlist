package projects

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"regexp"
	"slices"
	"strings"
	"time"

	"videocutlist/internal/db"
	exporter "videocutlist/internal/export"
	jobs "videocutlist/internal/jobs"
	jobqueue "videocutlist/internal/jobs/model"
	"videocutlist/internal/jobs/view"
	librarymedia "videocutlist/internal/library/media"
	"videocutlist/internal/projects/model"
	settingsmodel "videocutlist/internal/settings/model"
)

type BatchExportRequest struct {
	ProjectID       string
	IdempotencyKey  string
	ProjectRevision int64
	ItemIDs         []string
}

var (
	ErrInvalidBatchCursor = errors.New("invalid batch cursor")
	batchCursorID         = regexp.MustCompile(`^b_[A-Za-z0-9_-]{12,64}$`)
)

const batchCursorScope = "batches-v1"

type BatchExportUseCase struct {
	Projects  ProjectRepository
	Media     librarymedia.MediaCatalog
	Jobs      *jobs.JobsStore
	Scheduler *jobs.Scheduler
	Settings  *settingsmodel.RuntimeSettingsState
}

func (b BatchExportUseCase) Submit(ctx context.Context, request BatchExportRequest) (string, []view.Job, error) {
	if b.Projects == nil || b.Media == nil || b.Jobs == nil || b.Scheduler == nil {
		return "", nil, errors.New("batch export dependencies are required")
	}
	if request.ProjectRevision < 1 || !jobqueue.ValidCommandKey(request.IdempotencyKey) {
		return "", nil, errors.New("project revision and valid idempotency key are required")
	}
	admission, err := exportSubmissionAdmission(request)
	if err != nil {
		return "", nil, err
	}
	if replay, found, err := b.Scheduler.LookupCommand(ctx, admission); err != nil {
		return "", nil, err
	} else if found {
		return exportAdmissionResult(replay.Jobs)
	}
	replayOnFailure := func(failure error) (string, []view.Job, error) {
		result, found, lookupErr := b.Scheduler.LookupCommand(ctx, admission)
		if lookupErr != nil {
			return "", nil, lookupErr
		}
		if found {
			return exportAdmissionResult(result.Jobs)
		}
		return "", nil, failure
	}
	project, err := b.Projects.Get(ctx, request.ProjectID)
	if err != nil {
		return replayOnFailure(err)
	}
	if project.Revision != request.ProjectRevision {
		return replayOnFailure(store.ErrRevisionConflict)
	}
	items, err := SelectProjectItems(project.Document, request.ItemIDs)
	if err != nil {
		return replayOnFailure(err)
	}
	batchID, err := jobqueue.NewID("b_")
	if err != nil {
		return "", nil, err
	}
	jobs := make([]jobqueue.Job, 0, len(items))
	for _, item := range items {
		media, err := b.Media.Get(ctx, item.MediaID)
		if err != nil {
			return replayOnFailure(&ProjectItemError{ItemID: item.ID, Code: "media_unavailable"})
		}
		if strings.ContainsAny(item.ExportOptions.FilenameTemplate, `/\\`) {
			return replayOnFailure(&ProjectItemError{ItemID: item.ID, Code: "invalid_filename"})
		}
		resolved := cloneProjectItem(item)
		resolved.ExportOptions = resolved.ExportOptions.WithExportDefaults()
		snapshot := exporter.ExportSnapshot{ProjectRevision: project.Revision, MediaLabel: media.Name, Item: resolved, Source: exporter.SourceSnapshot{MediaID: media.ID, RootID: media.RootID, ETag: media.ETag, SizeBytes: media.SizeBytes, DurationMS: media.DurationMS}, RuntimeSettings: runtimeSettings(b.Settings)}
		payload, err := json.Marshal(snapshot)
		if err != nil {
			return "", nil, err
		}
		id, err := jobqueue.NewID("j_")
		if err != nil {
			return "", nil, err
		}
		jobs = append(jobs, jobqueue.Job{ID: id, BatchID: batchID, Kind: jobqueue.JobExport, ProjectID: request.ProjectID, ProjectItemID: item.ID, RequestJSON: string(payload)})
	}
	if len(jobs) == 0 {
		return replayOnFailure(errors.New("no project items selected"))
	}
	created, err := b.Scheduler.SubmitCommand(ctx, admission, jobs)
	if err != nil {
		if replay, found, lookupErr := b.Scheduler.LookupCommand(ctx, admission); lookupErr == nil && found {
			return exportAdmissionResult(replay.Jobs)
		}
		return "", nil, err
	}
	return exportAdmissionResult(created.Jobs)
}

func exportSubmissionAdmission(request BatchExportRequest) (jobqueue.CommandAdmission, error) {
	itemIDs := slices.Clone(request.ItemIDs)
	if itemIDs == nil {
		itemIDs = []string{}
	}
	seen := make(map[string]struct{}, len(itemIDs))
	for _, id := range itemIDs {
		if id == "" {
			return jobqueue.CommandAdmission{}, &ProjectItemError{Code: "item_id_required"}
		}
		if _, exists := seen[id]; exists {
			return jobqueue.CommandAdmission{}, &ProjectItemError{ItemID: id, Code: "item_id_duplicate"}
		}
		seen[id] = struct{}{}
	}
	slices.Sort(itemIDs)
	payload, err := json.Marshal(struct {
		ProjectRevision int64    `json:"projectRevision"`
		ItemIDs         []string `json:"itemIds"`
	}{request.ProjectRevision, itemIDs})
	if err != nil {
		return jobqueue.CommandAdmission{}, err
	}
	digest := sha256.Sum256(payload)
	return jobqueue.CommandAdmission{Key: request.IdempotencyKey, Scope: "export-submit", Kind: "export-submit", Target: request.ProjectID, Digest: hex.EncodeToString(digest[:])}, nil
}

func exportAdmissionResult(created []jobqueue.Job) (string, []view.Job, error) {
	result := make([]view.Job, 0, len(created))
	batchID := ""
	for _, job := range created {
		if batchID == "" {
			batchID = job.BatchID
		}
		result = append(result, view.FromRecord(job))
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

func (b BatchExportUseCase) Snapshot(ctx context.Context, batchID string) (Batch, string, error) {
	if b.Jobs == nil {
		return Batch{}, "", errors.New("batch export jobs are required")
	}
	// ponytail: three retries bound snapshot reads; reconnect if the batch keeps changing.
	for range 3 {
		before, err := b.Jobs.BatchCursor(ctx, batchID)
		if err != nil {
			return Batch{}, "", err
		}
		batch, err := b.Get(ctx, batchID)
		if err != nil {
			return Batch{}, "", err
		}
		after, err := b.Jobs.BatchCursor(ctx, batchID)
		if err != nil {
			return Batch{}, "", err
		}
		if before == after {
			return batch, after, nil
		}
	}
	return Batch{}, "", errors.New("batch changed while reading snapshot")
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
	result := Batch{BatchID: batchID, State: string(state), Progress: progress, Jobs: make([]view.Job, len(jobs))}
	for i, job := range jobs {
		result.Jobs[i] = view.FromRecord(job)
		if result.ProjectID == "" {
			result.ProjectID = job.ProjectID
			result.ProjectRevision = result.Jobs[i].ProjectRevision
		}
	}
	return result, nil
}

func (b BatchExportUseCase) List(ctx context.Context, cursor string, limit int) (BatchPage, error) {
	if b.Jobs == nil || limit < 1 || limit > 100 {
		return BatchPage{}, errors.New("batch list dependencies or limit are invalid")
	}
	after, err := decodeBatchCursor(cursor)
	if err != nil {
		return BatchPage{}, err
	}
	positions, err := b.Jobs.ListBatchIDs(ctx, jobqueue.JobExport, after, limit+1)
	if err != nil {
		return BatchPage{}, err
	}
	hasMore := len(positions) > limit
	if hasMore {
		positions = positions[:limit]
	}
	page := BatchPage{Items: make([]Batch, 0, len(positions))}
	for _, position := range positions {
		batch, err := b.Get(ctx, position.ID)
		if err != nil {
			return BatchPage{}, err
		}
		page.Items = append(page.Items, batch)
	}
	if hasMore {
		token := encodeBatchCursor(positions[len(positions)-1])
		page.NextCursor = &token
	}
	return page, nil
}

func encodeBatchCursor(position jobqueue.BatchPosition) string {
	payload := batchCursorScope + "\x00" + position.CreatedAt + "\x00" + position.ID
	return base64.RawURLEncoding.EncodeToString([]byte(payload))
}

func decodeBatchCursor(value string) (*jobqueue.BatchPosition, error) {
	if value == "" {
		return nil, nil
	}
	if len(value) > 256 {
		return nil, ErrInvalidBatchCursor
	}
	payload, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil || base64.RawURLEncoding.EncodeToString(payload) != value {
		return nil, ErrInvalidBatchCursor
	}
	scope, remainder, ok := strings.Cut(string(payload), "\x00")
	if !ok || scope != batchCursorScope {
		return nil, ErrInvalidBatchCursor
	}
	createdAt, id, ok := strings.Cut(remainder, "\x00")
	if !ok || strings.Contains(id, "\x00") || !batchCursorID.MatchString(id) {
		return nil, ErrInvalidBatchCursor
	}
	parsed, err := time.Parse(time.RFC3339Nano, createdAt)
	if err != nil || parsed.UTC().Format(time.RFC3339Nano) != createdAt {
		return nil, ErrInvalidBatchCursor
	}
	return &jobqueue.BatchPosition{CreatedAt: createdAt, ID: id}, nil
}

func (b BatchExportUseCase) Retry(ctx context.Context, jobID, idempotencyKey string) (Batch, error) {
	if b.Jobs == nil || b.Scheduler == nil || !jobqueue.ValidCommandKey(idempotencyKey) {
		return Batch{}, errors.New("batch export dependencies and valid idempotency key are required")
	}
	payload, err := json.Marshal(struct {
		JobID string `json:"jobId"`
	}{jobID})
	if err != nil {
		return Batch{}, err
	}
	digest := sha256.Sum256(payload)
	admission := jobqueue.CommandAdmission{Key: idempotencyKey, Scope: "export-retry", Kind: "export-retry", Target: jobID, Digest: hex.EncodeToString(digest[:])}
	if replay, found, err := b.Scheduler.LookupCommand(ctx, admission); err != nil {
		return Batch{}, err
	} else if found {
		return b.Get(ctx, replay.Jobs[0].BatchID)
	}
	original, err := b.Jobs.Get(ctx, jobID)
	if err != nil {
		return Batch{}, err
	}
	if original.Kind != jobqueue.JobExport || original.State != jobqueue.JobFailed {
		return Batch{}, jobqueue.ErrJobState
	}
	batchID, err := jobqueue.NewID("b_")
	if err != nil {
		return Batch{}, err
	}
	newJobID, err := jobqueue.NewID("j_")
	if err != nil {
		return Batch{}, err
	}
	result, err := b.Scheduler.SubmitCommand(ctx, admission, []jobqueue.Job{{ID: newJobID, BatchID: batchID, Kind: original.Kind, ProjectID: original.ProjectID, ProjectItemID: original.ProjectItemID, RequestJSON: original.RequestJSON}})
	if err != nil {
		if replay, found, lookupErr := b.Scheduler.LookupCommand(ctx, admission); lookupErr == nil && found {
			return b.Get(ctx, replay.Jobs[0].BatchID)
		}
		return Batch{}, err
	}
	return b.Get(ctx, result.Jobs[0].BatchID)
}
