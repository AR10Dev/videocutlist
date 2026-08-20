package application

import (
	"context"
	"database/sql"
	"errors"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"videocutlist/domain"
	"videocutlist/infrastructure/store"
)

type catalogStub struct {
	refreshes  int
	refreshErr error
}

func (c *catalogStub) List(context.Context, string, int) (MediaPage, error) { return MediaPage{}, nil }
func (c *catalogStub) Get(context.Context, string) (Media, error)           { return Media{}, nil }
func (c *catalogStub) Refresh(context.Context) error                        { c.refreshes++; return c.refreshErr }
func (c *catalogStub) Preview(context.Context, PreviewSpec) (domain.PreviewSpec, error) {
	return domain.PreviewSpec{}, nil
}

func TestMediaRefreshIsSynchronous(t *testing.T) {
	catalog := &catalogStub{}
	useCase := &MediaUseCase{Catalog: catalog}
	if err := useCase.RefreshMedia(context.Background()); err != nil {
		t.Fatal(err)
	}
	if catalog.refreshes != 1 {
		t.Fatalf("refreshes = %d", catalog.refreshes)
	}
}

func TestMediaRefreshFailureCanRetry(t *testing.T) {
	catalog := &catalogStub{refreshErr: errors.New("refresh failed")}
	useCase := &MediaUseCase{Catalog: catalog}
	if err := useCase.RefreshMedia(context.Background()); err == nil {
		t.Fatal("failed refresh succeeded")
	}
	catalog.refreshErr = nil
	if err := useCase.RefreshMedia(context.Background()); err != nil {
		t.Fatalf("retry = %v", err)
	}
}

type projectsStub struct {
	saves    int
	document domain.Document
}

func (p *projectsStub) Get(context.Context, string, string) (ProjectRecord, error) {
	return ProjectRecord{Document: p.document, UpdatedAt: time.Now()}, nil
}
func (p *projectsStub) Save(_ context.Context, _ string, _ string, document domain.Document) (ProjectRecord, error) {
	p.saves++
	document.Revision++
	p.document = document
	return ProjectRecord{Document: document, UpdatedAt: time.Now()}, nil
}

func TestProjectUseCaseValidatesBeforeRevisionSave(t *testing.T) {
	repository := &projectsStub{}
	useCase := ProjectUseCase{Repository: repository}
	bad := domain.Document{MediaID: "m_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", UIState: domain.UIState{Zoom: 0}}
	if _, err := useCase.Save(context.Background(), domain.Principal{Subject: "editor"}, "p_aaaaaaaaaaaa", bad, 1_000); err == nil || repository.saves != 0 {
		t.Fatalf("invalid save = %v, saves = %d", err, repository.saves)
	}
	good := bad
	good.UIState.Zoom = 1
	saved, err := useCase.Save(context.Background(), domain.Principal{Subject: "editor"}, "p_aaaaaaaaaaaa", good, 1_000)
	if err != nil || saved.Revision != 1 || repository.saves != 1 {
		t.Fatalf("saved = %#v, err = %v, saves = %d", saved, err, repository.saves)
	}
}

type jobsStub struct {
	mu               sync.Mutex
	creates, cancels int
	job              store.ExportJob
}

func (j *jobsStub) Create(_ context.Context, job store.ExportJob) (store.ExportJob, error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.creates++
	job.State = store.JobQueued
	job.CreatedAt = time.Now()
	job.UpdatedAt = job.CreatedAt
	j.job = job
	return job, nil
}
func (j *jobsStub) Get(context.Context, string, string) (store.ExportJob, error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.job, nil
}
func (j *jobsStub) Cancel(context.Context, string, string) (store.ExportJob, error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.cancels++
	j.job.State = store.JobCancelled
	return j.job, nil
}

type executorStub struct {
	started   chan struct{}
	cancelled chan struct{}
	once      sync.Once
}

func (e *executorStub) Execute(ctx context.Context, _ string, _ string, _ domain.Document) error {
	e.once.Do(func() { close(e.started) })
	<-ctx.Done()
	close(e.cancelled)
	return ctx.Err()
}

func project() Project {
	return Project{ID: "p_aaaaaaaaaaaa", Document: domain.Document{MediaID: "m_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", Revision: 1, UIState: domain.UIState{Zoom: 1}}}
}
func input() ExportInput {
	return ExportInput{Mode: "merge", CutStrategy: "stream_copy_preferred", Container: "mkv"}
}

func TestExportAdmissionPrecedesDurableCreation(t *testing.T) {
	jobs, executor := &jobsStub{}, &executorStub{started: make(chan struct{}), cancelled: make(chan struct{})}
	useCase := NewExportUseCase(jobs, executor, 1)
	if _, err := useCase.Create(context.Background(), domain.Principal{Subject: "editor"}, "p_aaaaaaaaaaaa", project(), input()); err != nil {
		t.Fatal(err)
	}
	<-executor.started
	if _, err := useCase.Create(context.Background(), domain.Principal{Subject: "editor"}, "p_aaaaaaaaaaaa", project(), input()); !errors.Is(err, ErrBusy) {
		t.Fatalf("second create = %v", err)
	}
	jobs.mu.Lock()
	creates := jobs.creates
	id := jobs.job.ID
	jobs.mu.Unlock()
	if creates != 1 {
		t.Fatalf("durable creates = %d", creates)
	}
	if err := useCase.Cancel(context.Background(), "editor", id); err != nil {
		t.Fatal(err)
	}
	<-executor.cancelled
}

func TestJobCancellationOrchestratesExecutorAndRepository(t *testing.T) {
	jobs, executor := &jobsStub{}, &executorStub{started: make(chan struct{}), cancelled: make(chan struct{})}
	useCase := NewExportUseCase(jobs, executor, 1)
	job, err := useCase.Create(context.Background(), domain.Principal{Subject: "editor"}, "p_aaaaaaaaaaaa", project(), input())
	if err != nil {
		t.Fatal(err)
	}
	<-executor.started
	jobs.mu.Lock()
	jobs.job.State = "running"
	jobs.mu.Unlock()
	if err := (JobUseCase{Exports: useCase}).Cancel(context.Background(), domain.Principal{Subject: "editor"}, job.ID); err != nil {
		t.Fatal(err)
	}
	<-executor.cancelled
	jobs.mu.Lock()
	cancels := jobs.cancels
	jobs.mu.Unlock()
	if cancels != 1 {
		t.Fatalf("repository cancels = %d", cancels)
	}
}

func TestExportJobResultIsSafeAndStateCompatible(t *testing.T) {
	retainUntil := time.Date(2026, 8, 20, 12, 0, 0, 0, time.UTC)
	record := store.ExportJob{ID: "j_aaaaaaaaaaaa", State: store.JobSucceeded, ResultJSON: sql.NullString{String: `{"outputName":"export.mkv","sizeBytes":42,"retainUntil":"` + retainUntil.Format(time.RFC3339) + `","warnings":[{"message":"Cut may start at an earlier keyframe."}],"outputDir":"/exports/private","stderr":"secret"}`, Valid: true}}
	job := jobResult(record)
	if job.Result == nil || job.Result.OutputName != "export.mkv" || len(job.Result.OutputNames) != 0 || job.Result.SizeBytes != 42 || !job.Result.RetainUntil.Equal(retainUntil) || len(job.Warnings) != 1 || job.Warnings[0] != "Cut may start at an earlier keyframe." || job.ErrorCode != nil {
		t.Fatalf("job = %#v", job)
	}

	failed := jobResult(store.ExportJob{ID: record.ID, State: store.JobFailed, ErrorCode: sql.NullString{String: "media_unavailable", Valid: true}, ResultJSON: record.ResultJSON})
	if failed.Result != nil || len(failed.Warnings) != 0 || failed.ErrorCode == nil || *failed.ErrorCode != "media_unavailable" {
		t.Fatalf("failed job = %#v", failed)
	}
}

func TestExportJobMalformedResultFailsClosed(t *testing.T) {
	job := jobResult(store.ExportJob{ID: "j_aaaaaaaaaaaa", State: store.JobSucceeded, ResultJSON: sql.NullString{String: `{"outputName":"/exports/private.mkv","warnings":[`, Valid: true}})
	if job.Result != nil || len(job.Warnings) != 0 {
		t.Fatalf("malformed result leaked: %#v", job)
	}
	job = jobResult(store.ExportJob{ID: "j_aaaaaaaaaaaa", State: store.JobSucceeded, ResultJSON: sql.NullString{String: `{"outputName":"/exports/private.mkv","sizeBytes":1,"retainUntil":"2026-08-20T12:00:00Z","warnings":[{"message":"secret"}]}`, Valid: true}})
	if job.Result != nil || len(job.Warnings) != 0 {
		t.Fatalf("unsafe result leaked: %#v", job)
	}
	for _, name := range []string{".", "..", "C:export.mkv", "dir/export.mkv", `dir\\export.mkv`, "export\x00.mkv", strings.Repeat("x", 256)} {
		job = jobResult(store.ExportJob{ID: "j_aaaaaaaaaaaa", State: store.JobSucceeded, ResultJSON: sql.NullString{String: `{"outputName":` + strconv.Quote(name) + `,"sizeBytes":1,"retainUntil":"2026-08-20T12:00:00Z","warnings":[{"message":"secret"}]}`, Valid: true}})
		if job.Result != nil || len(job.Warnings) != 0 {
			t.Fatalf("unsafe %q leaked: %#v", name, job)
		}
	}

	message := strings.Repeat("x", 501)
	job = jobResult(store.ExportJob{ID: "j_aaaaaaaaaaaa", State: store.JobSucceeded, ResultJSON: sql.NullString{String: `{"outputName":"export.mkv","sizeBytes":1,"retainUntil":"2026-08-20T12:00:00Z","warnings":[{"message":"` + message + `"}]}`, Valid: true}})
	if len(job.Warnings) != 1 || len(job.Warnings[0]) != 500 {
		t.Fatalf("warnings = %#v", job.Warnings)
	}
}

func stringPtr(value string) *string { return &value }
