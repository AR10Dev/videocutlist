package projects

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	store "videocutlist/internal/db"
	jobqueue "videocutlist/internal/jobs"
	"videocutlist/internal/projects/model"
)

type detectionCommandProjects struct {
	mu     sync.Mutex
	record ProjectRecord
	reads  int
}

func (p *detectionCommandProjects) Get(context.Context, string) (ProjectRecord, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.reads++
	return p.record, nil
}
func (p *detectionCommandProjects) Save(context.Context, string, int64, model.Document) (ProjectRecord, error) {
	return ProjectRecord{}, errors.New("not used")
}

type detectionCommandMedia struct {
	media Media
	reads atomic.Int64
}

func (m *detectionCommandMedia) List(context.Context, string, int) (MediaPage, error) {
	return MediaPage{}, nil
}
func (m *detectionCommandMedia) Browse(context.Context, string, string, int) (FolderPage, error) {
	return FolderPage{}, nil
}
func (m *detectionCommandMedia) Get(context.Context, string) (Media, error) {
	m.reads.Add(1)
	return m.media, nil
}
func (m *detectionCommandMedia) Refresh(context.Context) error { return nil }
func (m *detectionCommandMedia) Preview(context.Context, PreviewSpec) (model.PreviewSpec, error) {
	return model.PreviewSpec{}, nil
}

func detectionCommandFixture(t *testing.T) (*DetectionUseCase, *detectionCommandProjects, *detectionCommandMedia, string, *sql.DB) {
	t.Helper()
	ctx := t.Context()
	path := filepath.Join(t.TempDir(), "jobs.db")
	database, err := store.OpenDatabase(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	jobs, err := jobqueue.NewJobsStore(database)
	if err != nil {
		t.Fatal(err)
	}
	scheduler, err := jobqueue.NewScheduler(jobs, jobqueue.SchedulerConfig{QueueCapacity: 4, WorkerLimit: 1}, func(context.Context, jobqueue.Job) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	project := &detectionCommandProjects{record: ProjectRecord{Revision: 7, Document: model.Document{Items: []model.ProjectItem{{ID: "i_detection123456789012345", MediaID: "m_detection"}}}}}
	media := &detectionCommandMedia{media: Media{ID: "m_detection", ETag: "etag-original"}}
	useCase := &DetectionUseCase{Catalog: media, Projects: project, UnifiedJobs: jobs, Scheduler: scheduler}
	t.Cleanup(func() { _ = scheduler.Shutdown(context.Background()); _ = database.Close() })
	return useCase, project, media, path, database
}

func detectionCommandRequest() DetectionRequest {
	return DetectionRequest{MediaID: "m_detection", ProjectItemID: "i_detection123456789012345", ProjectRevision: 7, Kind: model.DetectSilence, SourceFingerprint: "etag-original", CredentialID: "credential_secret", MinDurationMS: 100}
}

func TestDetectionCommandReplayAfterEditAndRestart(t *testing.T) {
	useCase, project, media, path, originalDB := detectionCommandFixture(t)
	original, err := useCase.Submit(t.Context(), "p_detection", "detection-key", detectionCommandRequest())
	if err != nil {
		t.Fatal(err)
	}
	stored, err := useCase.UnifiedJobs.Get(t.Context(), original.ID)
	if err != nil {
		t.Fatal(err)
	}
	var snapshot DetectionRequest
	if err := json.Unmarshal([]byte(stored.RequestJSON), &snapshot); err != nil {
		t.Fatal(err)
	}
	if snapshot.SourceFingerprint != "etag-original" || snapshot.ProjectRevision != 7 || snapshot.CredentialID != "" || strings.Contains(stored.RequestJSON, "credential_secret") {
		t.Fatalf("unsafe or incomplete snapshot: %+v", snapshot)
	}
	project.mu.Lock()
	project.record.Revision = 8
	project.record.Document.Items = nil
	project.mu.Unlock()
	_ = useCase.Scheduler.Shutdown(context.Background())
	_ = originalDB.Close()
	database, err := store.OpenDatabase(t.Context(), path)
	if err != nil {
		t.Fatal(err)
	}
	jobs, err := jobqueue.NewJobsStore(database)
	if err != nil {
		t.Fatal(err)
	}
	scheduler, err := jobqueue.NewScheduler(jobs, jobqueue.SchedulerConfig{QueueCapacity: 4, WorkerLimit: 1}, func(context.Context, jobqueue.Job) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := scheduler.Shutdown(context.Background()); err != nil {
			t.Error(err)
		}
	}()
	defer func() {
		if err := database.Close(); err != nil {
			t.Error(err)
		}
	}()
	useCase.Scheduler, useCase.UnifiedJobs = scheduler, jobs
	replayed, err := useCase.Submit(t.Context(), "p_detection", "detection-key", detectionCommandRequest())
	if err != nil || replayed.ID != original.ID {
		t.Fatalf("replay = %+v, %v; want original %s", replayed, err, original.ID)
	}
	if project.reads != 1 || media.reads.Load() != 1 {
		t.Fatalf("replay revalidated project/media: reads=%d/%d", project.reads, media.reads.Load())
	}
}

func TestDetectionCommandRejectsChangedPayloadAndStaleRevisionWithoutAdmission(t *testing.T) {
	useCase, _, _, _, _ := detectionCommandFixture(t)
	request := detectionCommandRequest()
	if _, err := useCase.Submit(t.Context(), "p_detection", "detection-key", request); err != nil {
		t.Fatal(err)
	}
	changed := request
	changed.MinDurationMS++
	if _, err := useCase.Submit(t.Context(), "p_detection", "detection-key", changed); !errors.Is(err, jobqueue.ErrAdmissionConflict) {
		t.Fatalf("changed payload error = %v", err)
	}
	fresh := request
	fresh.ProjectRevision++
	if _, err := useCase.Submit(t.Context(), "p_detection", "stale-key", fresh); !errors.Is(err, store.ErrRevisionConflict) {
		t.Fatalf("stale revision error = %v", err)
	}
	if _, found, err := useCase.Scheduler.LookupCommand(t.Context(), detectionCommandAdmission("stale-key", "p_detection", fresh)); err != nil || found {
		t.Fatalf("stale submission reserved key: found=%v err=%v", found, err)
	}
	changedSource := request
	changedSource.SourceFingerprint = "etag-old"
	if _, err := useCase.Submit(t.Context(), "p_detection", "source-key", changedSource); !errors.Is(err, jobqueue.ErrSourceChanged) {
		t.Fatalf("stale source error = %v", err)
	}
	if _, found, err := useCase.Scheduler.LookupCommand(t.Context(), detectionCommandAdmission("source-key", "p_detection", changedSource)); err != nil || found {
		t.Fatalf("stale source submission reserved key: found=%v err=%v", found, err)
	}
}

func TestDetectionCommandConcurrentDuplicateAdmitsOnce(t *testing.T) {
	useCase, _, _, _, _ := detectionCommandFixture(t)
	const attempts = 8
	var wg sync.WaitGroup
	ids := make(chan string, attempts)
	errs := make(chan error, attempts)
	for range attempts {
		wg.Go(func() {
			job, err := useCase.Submit(t.Context(), "p_detection", "concurrent-key", detectionCommandRequest())
			if err != nil {
				errs <- err
				return
			}
			ids <- job.ID
		})
	}
	wg.Wait()
	close(ids)
	close(errs)
	var first string
	for id := range ids {
		if first == "" {
			first = id
		} else if id != first {
			t.Fatalf("duplicate jobs admitted: %s and %s", first, id)
		}
	}
	for err := range errs {
		t.Fatal(err)
	}
	if first == "" {
		t.Fatal("no job admitted")
	}
}

func detectionCommandAdmission(key, projectID string, request DetectionRequest) jobqueue.CommandAdmission {
	admission, _ := detectionAdmission(key, projectID, request)
	return admission
}
