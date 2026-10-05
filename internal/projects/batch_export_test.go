package projects

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"

	"videocutlist/internal/db"
	jobqueue "videocutlist/internal/jobs"
	"videocutlist/internal/projects/model"
)

type batchProjectRepo struct{ project ProjectRecord }

type failedBatchProjectRepo struct{ err error }

func (r failedBatchProjectRepo) Get(context.Context, string) (ProjectRecord, error) {
	return ProjectRecord{}, r.err
}
func (r failedBatchProjectRepo) Save(context.Context, string, int64, model.Document) (ProjectRecord, error) {
	return ProjectRecord{}, r.err
}

func (r batchProjectRepo) Get(context.Context, string) (ProjectRecord, error) { return r.project, nil }
func (r batchProjectRepo) Save(context.Context, string, int64, model.Document) (ProjectRecord, error) {
	return r.project, nil
}

type batchCatalog struct{ media map[string]Media }

func (c batchCatalog) Get(_ context.Context, id string) (Media, error)      { return c.media[id], nil }
func (c batchCatalog) List(context.Context, string, int) (MediaPage, error) { return MediaPage{}, nil }
func (c batchCatalog) Browse(context.Context, string, string, int) (FolderPage, error) {
	return FolderPage{}, nil
}
func (c batchCatalog) Refresh(context.Context) error { return nil }
func (c batchCatalog) Preview(context.Context, PreviewSpec) (model.PreviewSpec, error) {
	return model.PreviewSpec{}, nil
}

func TestSeparateExportResultRetainsAllAddressableOutputs(t *testing.T) {
	for _, count := range []int{101, 1000, 1001} {
		names := make([]string, count)
		for index := range names {
			names[index] = fmt.Sprintf("segment-%04d.mkv", index)
		}
		payload, err := json.Marshal(map[string]any{
			"container": "mkv", "outputNames": names,
			"sizeBytes": 1, "retainUntil": time.Now().Add(time.Hour),
		})
		if err != nil {
			t.Fatal(err)
		}
		record := jobqueue.Job{ID: "j_outputbound", State: jobqueue.JobSucceeded, ResultJSON: sql.NullString{String: string(payload), Valid: true}}
		result := jobResult(record).Result
		if count <= 1000 {
			if result == nil || len(result.OutputNames) != count {
				t.Fatalf("%d outputs disappeared: %#v", count, result)
			}
		} else if result != nil {
			t.Fatalf("over-bound output result accepted: %d", count)
		}
	}
}

func TestLegacyBatchJobDisplaysResolvedExportOptions(t *testing.T) {
	snapshot, err := json.Marshal(ExportSnapshot{Item: model.ProjectItem{ID: "i_aaaaaaaaaaaaaaaaaaaaaaaa"}})
	if err != nil {
		t.Fatal(err)
	}
	job := jobResult(jobqueue.Job{ID: "j_aaaaaaaaaaaa", RequestJSON: string(snapshot)})
	if job.Mode != "separate" || job.Selection != "segments" || job.Strategy != "stream_copy_preferred" || job.Container != "mkv" {
		t.Fatalf("legacy job options do not match worker defaults: %+v", job)
	}
}

func TestBatchExportSnapshotsItemsInProjectOrder(t *testing.T) {
	db, err := store.OpenDatabase(context.Background(), t.TempDir()+"/jobs.db")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Error(err)
		}
	})
	jobs, _ := jobqueue.NewJobsStore(db)
	scheduler, err := jobqueue.NewScheduler(jobs, jobqueue.SchedulerConfig{QueueCapacity: 4, WorkerLimit: 1}, func(context.Context, jobqueue.Job) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	items := []model.ProjectItem{{ID: "i_aaaaaaaaaaaaaaaaaaaaaaaa", MediaID: "m_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", Segments: []model.Segment{{StartMS: 0, EndMS: 100}}, ExportOptions: model.ExportOptions{Container: "mkv"}}, {ID: "i_bbbbbbbbbbbbbbbbbbbbbbbb", MediaID: "m_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", Segments: []model.Segment{{StartMS: 100, EndMS: 200}}}}
	uc := BatchExportUseCase{Projects: batchProjectRepo{}, Media: batchCatalog{media: map[string]Media{"m_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa": {ID: items[0].MediaID, ETag: "a", SizeBytes: 10, DurationMS: 300}, "m_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb": {ID: items[1].MediaID, ETag: "b", SizeBytes: 20, DurationMS: 400}}}, Jobs: jobs, Scheduler: scheduler}
	uc.Projects = batchProjectRepo{project: ProjectRecord{Document: model.Document{SchemaVersion: 2, Name: "Batch", Items: items}, Revision: 7}}
	batchID, submitted, err := uc.Submit(context.Background(), BatchExportRequest{ProjectID: "p_aaaaaaaaaaaa", IdempotencyKey: "snapshot-test", ProjectRevision: 7, ItemIDs: []string{items[1].ID, items[0].ID}})
	if err != nil {
		t.Fatal(err)
	}
	if len(submitted) != 2 || submitted[0].State != string(jobqueue.JobQueued) || submitted[0].CreatedAt.IsZero() {
		t.Fatalf("submitted = %#v", submitted)
	}
	first, err := jobs.Get(context.Background(), submitted[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	var snapshot ExportSnapshot
	if err := json.Unmarshal([]byte(first.RequestJSON), &snapshot); err != nil {
		t.Fatal(err)
	}
	if snapshot.Item.ID != items[0].ID || snapshot.ProjectRevision != 7 || snapshot.Source.ETag != "a" {
		t.Fatalf("snapshot = %#v", snapshot)
	}
	if options := snapshot.Item.ExportOptions; options.Mode != "separate" || options.Selection != "segments" || options.CutStrategy != "stream_copy_preferred" || options.Container != "mkv" {
		t.Fatalf("saved optional export settings did not reach worker snapshot: %+v", options)
	}
	items[0].Segments[0].EndMS = 999
	var unchanged ExportSnapshot
	_ = json.Unmarshal([]byte(first.RequestJSON), &unchanged)
	if unchanged.Item.Segments[0].EndMS == 999 {
		t.Fatal("snapshot changed after project mutation")
	}
	if state, progress, err := jobs.Batch(context.Background(), batchID); err != nil || state != jobqueue.JobQueued || progress != 0 {
		t.Fatalf("progress = %s %v %v", state, progress, err)
	}
}

func TestBatchExportReplayPrecedesCurrentProjectValidation(t *testing.T) {
	ctx := t.Context()
	path := t.TempDir() + "/jobs.db"
	database, err := store.OpenDatabase(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := database.Close(); err != nil {
			t.Error(err)
		}
	})
	jobs, err := jobqueue.NewJobsStore(database)
	if err != nil {
		t.Fatal(err)
	}
	scheduler, err := jobqueue.NewScheduler(jobs, jobqueue.SchedulerConfig{QueueCapacity: 4, WorkerLimit: 1}, func(context.Context, jobqueue.Job) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	mediaID := "m_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	secondMediaID := "m_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	item := model.ProjectItem{ID: "i_aaaaaaaaaaaaaaaaaaaaaaaa", MediaID: mediaID}
	secondItem := model.ProjectItem{ID: "i_bbbbbbbbbbbbbbbbbbbbbbbb", MediaID: secondMediaID}
	request := BatchExportRequest{ProjectID: "p_aaaaaaaaaaaa", IdempotencyKey: "replay-after-edit", ProjectRevision: 4, ItemIDs: []string{secondItem.ID, item.ID}}
	originalSelection := slices.Clone(request.ItemIDs)
	uc := BatchExportUseCase{
		Projects: batchProjectRepo{project: ProjectRecord{Revision: 4, Document: model.Document{SchemaVersion: 2, Name: "Batch", Items: []model.ProjectItem{item, secondItem}}}},
		Media: batchCatalog{media: map[string]Media{
			mediaID:       {ID: mediaID, ETag: "source-v1", SizeBytes: 10, DurationMS: 100},
			secondMediaID: {ID: secondMediaID, ETag: "source-v2", SizeBytes: 20, DurationMS: 200},
		}}, Jobs: jobs, Scheduler: scheduler,
	}
	originalBatch, originalJobs, err := uc.Submit(ctx, request)
	if err != nil {
		t.Fatal(err)
	}
	allSelection := request
	allSelection.IdempotencyKey = "empty-means-all"
	allSelection.ItemIDs = nil
	allBatch, allJobs, err := uc.Submit(ctx, allSelection)
	if err != nil || len(allJobs) != 2 {
		t.Fatalf("all-items selection = %q %#v, %v", allBatch, allJobs, err)
	}
	reordered := request
	reordered.ItemIDs = []string{item.ID, secondItem.ID}
	uc.Projects = failedBatchProjectRepo{err: store.ErrRevisionConflict}
	replayedBatch, replayedJobs, err := uc.Submit(ctx, reordered)
	if err != nil {
		t.Fatalf("replay after project edit with reordered selection: %v", err)
	}
	if replayedBatch != originalBatch || len(replayedJobs) != len(originalJobs) || replayedJobs[0].ID != originalJobs[0].ID || replayedJobs[1].ID != originalJobs[1].ID {
		t.Fatalf("replay = %q %#v; original = %q %#v", replayedBatch, replayedJobs, originalBatch, originalJobs)
	}
	if !slices.Equal(request.ItemIDs, originalSelection) {
		t.Fatalf("request item IDs mutated: got %v want %v", request.ItemIDs, originalSelection)
	}
	changedSet := request
	changedSet.ItemIDs = []string{item.ID}
	if _, _, err := uc.Submit(ctx, changedSet); !errors.Is(err, jobqueue.ErrAdmissionConflict) {
		t.Fatalf("changed selection replay error = %v, want admission conflict", err)
	}
	duplicate := request
	duplicate.ItemIDs = []string{item.ID, item.ID}
	if _, _, err := uc.Submit(ctx, duplicate); !errors.Is(err, ErrInvalidProject) {
		t.Fatalf("duplicate accepted selection error = %v, want invalid project", err)
	}
	duplicate.IdempotencyKey = "duplicate-invalid"
	if _, _, err := uc.Submit(ctx, duplicate); !errors.Is(err, ErrInvalidProject) {
		t.Fatalf("fresh duplicate selection error = %v, want invalid project", err)
	}
	changed := request
	changed.ProjectRevision++
	if _, _, err := uc.Submit(ctx, changed); !errors.Is(err, jobqueue.ErrAdmissionConflict) {
		t.Fatalf("changed revision replay error = %v, want admission conflict", err)
	}
	uc.Projects = batchProjectRepo{project: ProjectRecord{Revision: 4, Document: model.Document{SchemaVersion: 2, Name: "Batch", Items: []model.ProjectItem{item, secondItem}}}}
	stale := request
	stale.IdempotencyKey = "fresh-stale-revision"
	stale.ProjectRevision = 3
	if _, _, err := uc.Submit(ctx, stale); !errors.Is(err, store.ErrRevisionConflict) {
		t.Fatalf("fresh stale revision error = %v, want revision conflict", err)
	}
	var staleAdmissions int
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM command_admissions WHERE idempotency_key=?`, stale.IdempotencyKey).Scan(&staleAdmissions); err != nil || staleAdmissions != 0 {
		t.Fatalf("stale revision admissions = %d, %v", staleAdmissions, err)
	}
	var count int
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM jobs`).Scan(&count); err != nil || count != len(originalJobs)+len(allJobs) {
		t.Fatalf("jobs after replay/conflict = %d, %v", count, err)
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}
	database, err = store.OpenDatabase(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	reopenedJobs, err := jobqueue.NewJobsStore(database)
	if err != nil {
		t.Fatal(err)
	}
	reopenedScheduler, err := jobqueue.NewScheduler(reopenedJobs, jobqueue.SchedulerConfig{QueueCapacity: 4, WorkerLimit: 1}, func(context.Context, jobqueue.Job) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	reopened := BatchExportUseCase{
		Projects: batchProjectRepo{project: ProjectRecord{Revision: 5, Document: model.Document{SchemaVersion: 2, Name: "Edited", Items: []model.ProjectItem{{ID: "i_editedaaaaaaaaaaaaaaaaaa", MediaID: "m_edited"}}}}},
		Media:    batchCatalog{media: map[string]Media{}}, Jobs: reopenedJobs, Scheduler: reopenedScheduler,
	}
	replayedBatch, replayedJobs, err = reopened.Submit(ctx, request)
	if err != nil || replayedBatch != originalBatch || len(replayedJobs) != 2 || replayedJobs[0].ID != originalJobs[0].ID || replayedJobs[1].ID != originalJobs[1].ID {
		t.Fatalf("replay after restart and project edit = %q %#v, %v; original = %q %#v", replayedBatch, replayedJobs, err, originalBatch, originalJobs)
	}
	allSelection.ItemIDs = []string{}
	allReplayBatch, allReplayJobs, err := reopened.Submit(ctx, allSelection)
	if err != nil || allReplayBatch != allBatch || len(allReplayJobs) != len(allJobs) || allReplayJobs[0].ID != allJobs[0].ID || allReplayJobs[1].ID != allJobs[1].ID {
		t.Fatalf("empty/all replay after restart and project edit = %q %#v, %v; original = %q %#v", allReplayBatch, allReplayJobs, err, allBatch, allJobs)
	}
}

func TestBatchListUsesStableOpaqueCursor(t *testing.T) {
	ctx := t.Context()
	database, err := store.OpenDatabase(ctx, t.TempDir()+"/jobs.db")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := database.Close(); err != nil {
			t.Error(err)
		}
	})
	jobs, err := jobqueue.NewJobsStore(database)
	if err != nil {
		t.Fatal(err)
	}
	for i, batchID := range []string{"b_aaaaaaaaaaaa", "b_bbbbbbbbbbbb", "b_cccccccccccc"} {
		jobID := fmt.Sprintf("j_batchpage%03d", i)
		job := jobqueue.Job{ID: jobID, BatchID: batchID, Kind: jobqueue.JobExport, ProjectID: "p_aaaaaaaaaaaa", ProjectItemID: "i_aaaaaaaaaaaaaaaaaaaaaaaa", RequestJSON: `{}`}
		if _, err := jobs.Create(ctx, job); err != nil {
			t.Fatal(err)
		}
		createdAt := "2025-01-02T00:00:00Z"
		if i == 2 {
			createdAt = "2025-01-03T00:00:00Z"
		}
		if _, err := database.ExecContext(ctx, `UPDATE jobs SET created_at=? WHERE id=?`, createdAt, jobID); err != nil {
			t.Fatal(err)
		}
	}
	useCase := BatchExportUseCase{Jobs: jobs}
	first, err := useCase.List(ctx, "", 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(first.Items) != 2 || first.Items[0].BatchID != "b_cccccccccccc" || first.Items[1].BatchID != "b_bbbbbbbbbbbb" || first.NextCursor == nil {
		t.Fatalf("first page = %+v", first)
	}
	second, err := useCase.List(ctx, *first.NextCursor, 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(second.Items) != 1 || second.Items[0].BatchID != "b_aaaaaaaaaaaa" || second.NextCursor != nil {
		t.Fatalf("second page = %+v", second)
	}
	for _, cursor := range []string{"invalid", strings.Repeat("x", 257)} {
		if _, err := useCase.List(ctx, cursor, 2); !errors.Is(err, ErrInvalidBatchCursor) {
			t.Errorf("cursor length %d error = %v, want invalid batch cursor", len(cursor), err)
		}
	}
}

func TestBatchExportUsesSchedulerCapacity(t *testing.T) {
	db, err := store.OpenDatabase(context.Background(), t.TempDir()+"/jobs.db")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Error(err)
		}
	})
	jobs, _ := jobqueue.NewJobsStore(db)
	scheduler, err := jobqueue.NewScheduler(jobs, jobqueue.SchedulerConfig{QueueCapacity: 1, WorkerLimit: 1}, func(context.Context, jobqueue.Job) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	id := "m_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	items := []model.ProjectItem{{ID: "i_aaaaaaaaaaaaaaaaaaaaaaaa", MediaID: id}, {ID: "i_bbbbbbbbbbbbbbbbbbbbbbbb", MediaID: id}}
	uc := BatchExportUseCase{
		Projects:  batchProjectRepo{project: ProjectRecord{Revision: 1, Document: model.Document{SchemaVersion: 2, Name: "Batch", Items: items}}},
		Media:     batchCatalog{media: map[string]Media{id: {ID: id, ETag: "a", SizeBytes: 1, DurationMS: 10}}},
		Jobs:      jobs,
		Scheduler: scheduler,
	}
	if _, _, err := uc.Submit(context.Background(), BatchExportRequest{ProjectID: "p_aaaaaaaaaaaa", IdempotencyKey: "capacity-test", ProjectRevision: 1}); !errors.Is(err, jobqueue.ErrQueueFull) {
		t.Fatalf("capacity error = %v", err)
	}
	var count int
	if err := db.QueryRowContext(context.Background(), `SELECT COUNT(*) FROM jobs`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("rejected batch created %d jobs", count)
	}
}

func TestBatchExportRetryCreatesNewQueuedJobFromImmutableSnapshot(t *testing.T) {
	ctx := context.Background()
	db, err := store.OpenDatabase(ctx, t.TempDir()+"/jobs.db")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Error(err)
		}
	})
	jobs, err := jobqueue.NewJobsStore(db)
	if err != nil {
		t.Fatal(err)
	}
	snapshot := `{"projectRevision":3,"projectItem":{"id":"i_aaaaaaaaaaaaaaaaaaaaaaaa"}}`
	original := jobqueue.Job{
		ID:            "j_original0001",
		BatchID:       "b_original0001",
		Kind:          jobqueue.JobExport,
		ProjectID:     "p_aaaaaaaaaaaa",
		ProjectItemID: "i_aaaaaaaaaaaaaaaaaaaaaaaa",
		RequestJSON:   snapshot,
	}
	if _, err := jobs.Create(ctx, original); err != nil {
		t.Fatal(err)
	}
	if _, err := jobs.Start(ctx, original.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := jobs.Fail(ctx, original.ID, "export_failed"); err != nil {
		t.Fatal(err)
	}
	scheduler, err := jobqueue.NewScheduler(jobs, jobqueue.SchedulerConfig{QueueCapacity: 2, WorkerLimit: 1}, func(context.Context, jobqueue.Job) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	useCase := BatchExportUseCase{Jobs: jobs, Scheduler: scheduler}
	batch, err := useCase.Retry(ctx, original.ID, "retry-test")
	if err != nil {
		t.Fatal(err)
	}
	if len(batch.Jobs) != 1 || batch.Jobs[0].ID == original.ID || batch.Jobs[0].State != "queued" {
		t.Fatalf("retry batch = %+v", batch)
	}
	retry, err := jobs.Get(ctx, batch.Jobs[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	if retry.RequestJSON != snapshot || retry.ProjectItemID != original.ProjectItemID {
		t.Fatalf("retry changed immutable snapshot: %+v", retry)
	}
	replayed, err := useCase.Retry(ctx, original.ID, "retry-test")
	if err != nil || replayed.BatchID != batch.BatchID || len(replayed.Jobs) != 1 || replayed.Jobs[0].ID != batch.Jobs[0].ID {
		t.Fatalf("retry replay = %+v, %v; original = %+v", replayed, err, batch)
	}
	if _, err := useCase.Retry(ctx, "j_differentjob", "retry-test"); !errors.Is(err, jobqueue.ErrAdmissionConflict) {
		t.Fatalf("retry key reused for another job = %v, want admission conflict", err)
	}
}

func TestBatchExportRunnerPersistsSuccessfulResult(t *testing.T) {
	ctx := context.Background()
	db, err := store.OpenDatabase(ctx, t.TempDir()+"/jobs.db")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Error(err)
		}
	})
	jobs, err := jobqueue.NewJobsStore(db)
	if err != nil {
		t.Fatal(err)
	}
	mediaID := "m_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	snapshot := ExportSnapshot{Source: SourceSnapshot{MediaID: mediaID, ETag: "v1", SizeBytes: 10, DurationMS: 100}}
	payload, _ := json.Marshal(snapshot)
	job := jobqueue.Job{ID: "j_result000001", BatchID: "b_result000001", Kind: jobqueue.JobExport, ProjectID: "p_aaaaaaaaaaaa", ProjectItemID: "i_aaaaaaaaaaaaaaaaaaaaaaaa", RequestJSON: string(payload)}
	if _, err := jobs.Create(ctx, job); err != nil {
		t.Fatal(err)
	}
	if _, err := jobs.Start(ctx, job.ID); err != nil {
		t.Fatal(err)
	}
	uc := BatchExportUseCase{
		Media: batchCatalog{media: map[string]Media{mediaID: {ID: mediaID, ETag: "v1", SizeBytes: 10, DurationMS: 100}}},
		Jobs:  jobs,
		RunSnapshot: func(_ context.Context, jobID string, snapshot ExportSnapshot) (string, error) {
			if jobID != job.ID {
				t.Fatalf("runner job ID = %q", jobID)
			}
			if options := snapshot.Item.ExportOptions; options.Mode != "separate" || options.Selection != "segments" || options.CutStrategy != "stream_copy_preferred" || options.Container != "mkv" {
				t.Fatalf("worker received incomplete legacy export settings: %+v", options)
			}
			return `{"outputName":"clip.mkv","sizeBytes":10,"retainUntil":"2030-01-01T00:00:00Z"}`, nil
		},
	}
	if err := uc.RunQueuedSnapshot(ctx, job); err != nil {
		t.Fatal(err)
	}
	stored, err := jobs.Get(ctx, job.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.State != jobqueue.JobSucceeded || !stored.ResultJSON.Valid || !strings.Contains(stored.ResultJSON.String, "clip.mkv") {
		t.Fatalf("stored result = %+v", stored)
	}
}

func TestBatchExportRunnerRejectsChangedSource(t *testing.T) {
	id := "m_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	called := false
	uc := BatchExportUseCase{
		Media:       batchCatalog{media: map[string]Media{id: {ID: id, ETag: "changed", SizeBytes: 1, DurationMS: 10}}},
		RunSnapshot: func(context.Context, string, ExportSnapshot) (string, error) { called = true; return `{}`, nil },
	}
	snapshot := ExportSnapshot{Source: SourceSnapshot{MediaID: id, ETag: "original", SizeBytes: 1, DurationMS: 10}}
	payload, _ := json.Marshal(snapshot)
	err := uc.RunQueuedSnapshot(context.Background(), jobqueue.Job{RequestJSON: string(payload)})
	if err == nil || !errors.Is(err, jobqueue.ErrSourceChanged) || err.Error() != "source_changed" {
		t.Fatalf("runner error = %v", err)
	}
	if called {
		t.Fatal("export runner called for changed source")
	}
	missing := BatchExportUseCase{Media: batchCatalog{media: map[string]Media{}}, RunSnapshot: uc.RunSnapshot}
	if err := missing.RunQueuedSnapshot(context.Background(), jobqueue.Job{RequestJSON: string(payload)}); !errors.Is(err, jobqueue.ErrSourceChanged) {
		t.Fatalf("missing source error = %v", err)
	}
}

func TestBatchExportSchedulerPersistsSourceChangedFailure(t *testing.T) {
	db, err := store.OpenDatabase(context.Background(), t.TempDir()+"/jobs.db")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Error(err)
		}
	})
	jobs, err := jobqueue.NewJobsStore(db)
	if err != nil {
		t.Fatal(err)
	}
	id := "m_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	payload, err := json.Marshal(ExportSnapshot{Source: SourceSnapshot{MediaID: id, ETag: "original", SizeBytes: 1, DurationMS: 10}})
	if err != nil {
		t.Fatal(err)
	}
	called := false
	uc := BatchExportUseCase{
		Media: batchCatalog{media: map[string]Media{id: {ID: id, ETag: "changed", SizeBytes: 1, DurationMS: 10}}},
		RunSnapshot: func(context.Context, string, ExportSnapshot) (string, error) {
			called = true
			return `{}`, nil
		},
	}
	scheduler, err := jobqueue.NewScheduler(jobs, jobqueue.SchedulerConfig{QueueCapacity: 1, WorkerLimit: 1}, uc.RunQueuedSnapshot)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := scheduler.Submit(context.Background(), []jobqueue.Job{{
		ID:            "j_000000000081",
		BatchID:       "b_000000000081",
		Kind:          jobqueue.JobExport,
		ProjectID:     "p_aaaaaaaaaaaa",
		ProjectItemID: "i_aaaaaaaaaaaaaaaaaaaaaaaa",
		RequestJSON:   string(payload),
	}}); err != nil {
		t.Fatal(err)
	}
	scheduler.Start()
	t.Cleanup(func() {
		if err := scheduler.Shutdown(context.Background()); err != nil {
			t.Error(err)
		}
	})
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		job, getErr := jobs.Get(context.Background(), "j_000000000081")
		if getErr == nil && job.State == jobqueue.JobFailed {
			if job.ErrorCode.String != "source_changed" {
				t.Fatalf("job error code = %q; want source_changed", job.ErrorCode.String)
			}
			if called {
				t.Fatal("export runner called for changed source")
			}
			return
		}
		time.Sleep(time.Millisecond)
	}
	job, getErr := jobs.Get(context.Background(), "j_000000000081")
	t.Fatalf("job = %#v, err = %v; want failed source_changed", job, getErr)
}

func TestBatchExportRunningCancellationPropagatesContext(t *testing.T) {
	db, err := store.OpenDatabase(context.Background(), t.TempDir()+"/jobs.db")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Error(err)
		}
	})
	jobs, _ := jobqueue.NewJobsStore(db)
	started := make(chan struct{})
	cancelObserved := make(chan struct{})
	id := "m_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	catalog := batchCatalog{media: map[string]Media{id: {ID: id, ETag: "a", SizeBytes: 1, DurationMS: 10}}}
	var uc BatchExportUseCase
	scheduler, err := jobqueue.NewScheduler(jobs, jobqueue.SchedulerConfig{QueueCapacity: 1, WorkerLimit: 1}, func(ctx context.Context, job jobqueue.Job) error {
		return uc.RunQueuedSnapshot(ctx, job)
	})
	if err != nil {
		t.Fatal(err)
	}
	uc = BatchExportUseCase{
		Projects: batchProjectRepo{project: ProjectRecord{Revision: 1, Document: model.Document{SchemaVersion: 2, Name: "Batch", Items: []model.ProjectItem{{ID: "i_aaaaaaaaaaaaaaaaaaaaaaaa", MediaID: id}}}}},
		Media:    catalog, Jobs: jobs, Scheduler: scheduler,
		RunSnapshot: func(ctx context.Context, _ string, _ ExportSnapshot) (string, error) {
			close(started)
			<-ctx.Done()
			close(cancelObserved)
			return "", ctx.Err()
		},
	}
	scheduler.Start()
	t.Cleanup(func() {
		if err := scheduler.Shutdown(context.Background()); err != nil {
			t.Error(err)
		}
	})
	batchID, submitted, err := uc.Submit(context.Background(), BatchExportRequest{ProjectID: "p_aaaaaaaaaaaa", IdempotencyKey: "running-cancel", ProjectRevision: 1})
	if err != nil {
		t.Fatal(err)
	}
	<-started
	if err := uc.Cancel(context.Background(), batchID); err != nil {
		t.Fatal(err)
	}
	select {
	case <-cancelObserved:
	case <-time.After(time.Second):
		t.Fatal("export runner did not observe cancellation")
	}
	state, progress, err := jobs.Batch(context.Background(), batchID)
	if err != nil || state != jobqueue.JobCancelled || progress != 1 {
		t.Fatalf("running cancellation = %s %v %v", state, progress, err)
	}
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		job, getErr := jobs.Get(context.Background(), submitted[0].ID)
		if getErr == nil && job.State == jobqueue.JobCancelled {
			return
		}
		time.Sleep(time.Millisecond)
	}
	job, getErr := jobs.Get(context.Background(), submitted[0].ID)
	t.Fatalf("job = %#v, err = %v; want cancelled", job, getErr)
}

func TestBatchExportCancellationAndSourceFingerprint(t *testing.T) {
	db, err := store.OpenDatabase(context.Background(), t.TempDir()+"/jobs.db")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Error(err)
		}
	})
	jobs, _ := jobqueue.NewJobsStore(db)
	scheduler, err := jobqueue.NewScheduler(jobs, jobqueue.SchedulerConfig{QueueCapacity: 1, WorkerLimit: 1}, func(context.Context, jobqueue.Job) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	id := "m_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	item := model.ProjectItem{ID: "i_aaaaaaaaaaaaaaaaaaaaaaaa", MediaID: id}
	uc := BatchExportUseCase{Projects: batchProjectRepo{project: ProjectRecord{Revision: 1, Document: model.Document{SchemaVersion: 2, Name: "Batch", Items: []model.ProjectItem{item}}}}, Media: batchCatalog{media: map[string]Media{id: {ID: id, ETag: "a", SizeBytes: 1, DurationMS: 10}}}, Jobs: jobs, Scheduler: scheduler}
	batchID, _, err := uc.Submit(context.Background(), BatchExportRequest{ProjectID: "p_aaaaaaaaaaaa", IdempotencyKey: "cancel-source", ProjectRevision: 1})
	if err != nil {
		t.Fatal(err)
	}
	if err := uc.Cancel(context.Background(), batchID); err != nil {
		t.Fatal(err)
	}
	state, progress, err := jobs.Batch(context.Background(), batchID)
	if err != nil || state != jobqueue.JobCancelled || progress != 1 {
		t.Fatalf("cancel progress = %s %v %v", state, progress, err)
	}
	if err := ValidateSnapshot(ExportSnapshot{Source: SourceSnapshot{MediaID: id, ETag: "a", SizeBytes: 1, DurationMS: 10}}, Media{ID: id, ETag: "b", SizeBytes: 1, DurationMS: 10}); err == nil || err.Error() != "source_changed" {
		t.Fatalf("fingerprint error = %v", err)
	}
}
