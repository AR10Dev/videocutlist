package application

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"editapp/domain"
)

type catalogStub struct{ refreshes int }

func (c *catalogStub) List(context.Context, string, int) (MediaPage, error) { return MediaPage{}, nil }
func (c *catalogStub) Get(context.Context, string) (Media, error)           { return Media{}, nil }
func (c *catalogStub) Refresh(context.Context) error                        { c.refreshes++; return nil }
func (c *catalogStub) Preview(context.Context, PreviewSpec) (domain.PreviewSpec, error) {
	return domain.PreviewSpec{}, nil
}

func TestMediaRefreshThrottleLivesInUseCase(t *testing.T) {
	catalog := &catalogStub{}
	useCase := &MediaUseCase{Catalog: catalog, Refresh: NewRefreshJobs()}
	if _, err := useCase.RefreshMedia(context.Background(), domain.Principal{Subject: "editor"}); err != nil {
		t.Fatal(err)
	}
	if _, err := useCase.RefreshMedia(context.Background(), domain.Principal{Subject: "editor"}); !errors.Is(err, ErrBusy) {
		t.Fatalf("second refresh = %v", err)
	}
	if catalog.refreshes != 1 {
		t.Fatalf("refreshes = %d", catalog.refreshes)
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
	job              ExportJob
}

func (j *jobsStub) Create(_ context.Context, job ExportJob) (ExportJob, error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.creates++
	job.State = "queued"
	job.CreatedAt = time.Now()
	job.UpdatedAt = job.CreatedAt
	j.job = job
	return job, nil
}
func (j *jobsStub) Get(context.Context, string, string) (ExportJob, error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.job, nil
}
func (j *jobsStub) Cancel(context.Context, string, string) (ExportJob, error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.cancels++
	j.job.State = "cancelled"
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
	if err := (JobUseCase{Exports: useCase, Refresh: NewRefreshJobs()}).Cancel(context.Background(), domain.Principal{Subject: "editor"}, job.ID); err != nil {
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
