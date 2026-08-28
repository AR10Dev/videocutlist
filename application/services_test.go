package application

import (
	"context"
	"database/sql"
	"encoding/json"
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
	browse     FolderPage
}

func (c *catalogStub) List(context.Context, string, int) (MediaPage, error) { return MediaPage{}, nil }
func (c *catalogStub) Browse(context.Context, string, string, int) (FolderPage, error) {
	return c.browse, nil
}
func (c *catalogStub) Get(context.Context, string) (Media, error) { return Media{}, nil }
func (c *catalogStub) Refresh(context.Context) error              { c.refreshes++; return c.refreshErr }
func (c *catalogStub) Preview(context.Context, PreviewSpec) (domain.PreviewSpec, error) {
	return domain.PreviewSpec{}, nil
}

func TestMediaBrowseForwardsToCatalog(t *testing.T) {
	want := FolderPage{Folders: []FolderNode{{ID: "f_opaque", Label: "clips"}}}
	useCase := &MediaUseCase{Catalog: &catalogStub{browse: want}, Configured: true}
	got, err := useCase.Browse(context.Background(), "f_parent", "m_cursor", 25)
	if err != nil || len(got.Folders) != 1 || got.Folders[0].ID != want.Folders[0].ID {
		t.Fatalf("browse = %#v, err = %v", got, err)
	}
}

func TestMediaRefreshIsSynchronous(t *testing.T) {
	catalog := &catalogStub{}
	useCase := &MediaUseCase{Catalog: catalog, Configured: true}
	if err := useCase.RefreshMedia(context.Background()); err != nil {
		t.Fatal(err)
	}
	if catalog.refreshes != 1 {
		t.Fatalf("refreshes = %d", catalog.refreshes)
	}
}

type cancellableCatalog struct {
	started chan struct{}
	items   []Media
}

func (c *cancellableCatalog) List(context.Context, string, int) (MediaPage, error) {
	return MediaPage{Items: c.items}, nil
}
func (c *cancellableCatalog) Browse(context.Context, string, string, int) (FolderPage, error) {
	return FolderPage{}, nil
}
func (c *cancellableCatalog) Get(context.Context, string) (Media, error) { return Media{}, nil }
func (c *cancellableCatalog) Refresh(ctx context.Context) error {
	close(c.started)
	<-ctx.Done()
	return ctx.Err()
}
func (c *cancellableCatalog) Preview(context.Context, PreviewSpec) (domain.PreviewSpec, error) {
	return domain.PreviewSpec{}, nil
}

type boundedRecoveryCatalog struct {
	recoveryStarted chan struct{}
	releaseRecovery chan struct{}
	mu              sync.Mutex
	refreshes       int
}

func (c *boundedRecoveryCatalog) List(ctx context.Context, _ string, _ int) (MediaPage, error) {
	close(c.recoveryStarted)
	select {
	case <-c.releaseRecovery:
		return MediaPage{}, nil
	case <-ctx.Done():
		return MediaPage{}, ctx.Err()
	}
}
func (c *boundedRecoveryCatalog) Browse(context.Context, string, string, int) (FolderPage, error) {
	return FolderPage{}, nil
}
func (c *boundedRecoveryCatalog) Get(context.Context, string) (Media, error) { return Media{}, nil }
func (c *boundedRecoveryCatalog) Refresh(ctx context.Context) error {
	c.mu.Lock()
	c.refreshes++
	refreshes := c.refreshes
	c.mu.Unlock()
	if refreshes > 1 {
		return errors.New("newer refresh failed")
	}
	return ctx.Err()
}
func (c *boundedRecoveryCatalog) Preview(context.Context, PreviewSpec) (domain.PreviewSpec, error) {
	return domain.PreviewSpec{}, nil
}

func TestMediaImportCancellationBoundsStatusRecovery(t *testing.T) {
	catalog := &boundedRecoveryCatalog{recoveryStarted: make(chan struct{}), releaseRecovery: make(chan struct{})}
	useCase := &MediaUseCase{Catalog: catalog, Configured: true}
	job, err := useCase.StartImport(context.Background(), domain.Principal{Subject: "owner"})
	if err != nil {
		t.Fatal(err)
	}
	if err := useCase.CancelImport(context.Background(), domain.Principal{Subject: "owner"}, job.ID); err != nil {
		t.Fatal(err)
	}
	<-catalog.recoveryStarted
	deadline := time.Now().Add(mediaStatusRecoveryTimeout + time.Second)
	for time.Now().Before(deadline) {
		status, statusErr := useCase.ImportStatus(context.Background(), domain.Principal{Subject: "owner"}, job.ID)
		if statusErr == nil && status.State == "cancelled" {
			// Let runImport schedule its retention timer before the next test mutates the test knob.
			timer := time.NewTimer(10 * time.Millisecond)
			<-timer.C
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("cancelled import remained running past bounded recovery")
}

func TestCancelledRefreshCannotOverwriteNewerFailure(t *testing.T) {
	catalog := &boundedRecoveryCatalog{recoveryStarted: make(chan struct{}), releaseRecovery: make(chan struct{})}
	useCase := &MediaUseCase{Catalog: catalog, Configured: true}
	cancelled := make(chan error, 1)
	ctx, cancel := context.WithCancel(context.Background())
	go func() { cancelled <- useCase.RefreshMedia(ctx) }()
	cancel()
	<-catalog.recoveryStarted
	if err := useCase.RefreshMedia(context.Background()); err == nil {
		t.Fatal("newer refresh unexpectedly succeeded")
	}
	close(catalog.releaseRecovery)
	<-cancelled
	if got := useCase.Status(); got.State != LibraryFailed {
		t.Fatalf("status after newer refresh failure = %#v", got)
	}
}

func TestMediaImportCancellationRestoresUsableLibraryStatus(t *testing.T) {
	catalog := &cancellableCatalog{started: make(chan struct{}), items: []Media{{ID: "m_test"}}}
	useCase := &MediaUseCase{Catalog: catalog, Configured: true}
	job, err := useCase.StartImport(context.Background(), domain.Principal{Subject: "owner"})
	if err != nil {
		t.Fatal(err)
	}
	<-catalog.started
	if err := useCase.CancelImport(context.Background(), domain.Principal{Subject: "owner"}, job.ID); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		status, statusErr := useCase.ImportStatus(context.Background(), domain.Principal{Subject: "owner"}, job.ID)
		if statusErr == nil && status.State == "cancelled" {
			if got := useCase.Status(); got.State != LibraryReadyWithMedia {
				t.Fatalf("status after cancellation = %#v", got)
			}
			timer := time.NewTimer(10 * time.Millisecond)
			<-timer.C
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("cancelled import was not observable")
}

func TestMediaImportTerminalJobsExpireAfterRetention(t *testing.T) {
	previousRetention := mediaImportRetention
	mediaImportRetention = 10 * time.Millisecond
	defer func() { mediaImportRetention = previousRetention }()

	useCase := &MediaUseCase{Catalog: &catalogStub{}, Configured: true}
	job, err := useCase.StartImport(context.Background(), domain.Principal{Subject: "owner"})
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if status, statusErr := useCase.ImportStatus(context.Background(), domain.Principal{Subject: "owner"}, job.ID); statusErr == nil && status.State == "succeeded" {
			break
		}
		time.Sleep(time.Millisecond)
	}
	if _, err := useCase.ImportStatus(context.Background(), domain.Principal{Subject: "owner"}, job.ID); err != nil {
		t.Fatal("terminal job was not queryable: ", err)
	}
	time.Sleep(25 * time.Millisecond)
	if _, err := useCase.ImportStatus(context.Background(), domain.Principal{Subject: "owner"}, job.ID); err == nil {
		t.Fatal("expired terminal job remained queryable")
	}
}

func TestMediaRefreshFailureCanRetry(t *testing.T) {
	catalog := &catalogStub{refreshErr: errors.New("refresh failed")}
	useCase := &MediaUseCase{Catalog: catalog, Configured: true}
	if err := useCase.RefreshMedia(context.Background()); err == nil {
		t.Fatal("failed refresh succeeded")
	}
	catalog.refreshErr = nil
	if err := useCase.RefreshMedia(context.Background()); err != nil {
		t.Fatalf("retry = %v", err)
	}
}

func TestMediaLibraryStatusNeverExposesRefreshError(t *testing.T) {
	catalog := &catalogStub{refreshErr: errors.New("scan /private/media/clip.mp4 failed")}
	useCase := &MediaUseCase{Catalog: catalog, Configured: true}
	if err := useCase.RefreshMedia(context.Background()); err == nil {
		t.Fatal("refresh succeeded")
	}
	if got := useCase.Status(); got.State != LibraryFailed || got.Message != "Media library scan failed. Try refreshing it." {
		t.Fatalf("status = %#v", got)
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
	bad := domain.Document{SchemaVersion: domain.ProjectSchemaVersion, Name: "Project", Items: []domain.ProjectItem{{ID: "i_aaaaaaaaaaaaaaaaaaaaaaaa", MediaID: "m_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", EditorState: &domain.UIState{Zoom: 0}}}}
	if _, err := useCase.Save(context.Background(), domain.Principal{Subject: "editor"}, "p_aaaaaaaaaaaa", bad, 1_000); err == nil || repository.saves != 0 {
		t.Fatalf("invalid save = %v, saves = %d", err, repository.saves)
	}
	good := bad
	good.Items[0].EditorState.Zoom = 1
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

func (e *executorStub) Preflight(context.Context, domain.Principal, string, Project, ExportInput) (ExportPreflight, error) {
	return ExportPreflight{Allowed: true}, nil
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

func TestExportDurableRequestPreservesDestinationAndTemplate(t *testing.T) {
	jobs, executor := &jobsStub{}, &executorStub{started: make(chan struct{}), cancelled: make(chan struct{})}
	useCase := NewExportUseCase(jobs, executor, 1)
	request := input()
	request.DestinationID = "archive"
	request.FilenameTemplate = "{source}-{segment}.{ext}"
	if _, err := useCase.Create(context.Background(), domain.Principal{Subject: "editor"}, "p_aaaaaaaaaaaa", project(), request); err != nil {
		t.Fatal(err)
	}
	jobs.mu.Lock()
	encoded := jobs.job.RequestJSON
	jobs.mu.Unlock()
	var durable ExportInput
	if err := json.Unmarshal([]byte(encoded), &durable); err != nil {
		t.Fatal(err)
	}
	if durable.DestinationID != request.DestinationID || durable.FilenameTemplate != request.FilenameTemplate {
		t.Fatalf("durable request = %#v", durable)
	}
	if err := useCase.Cancel(context.Background(), "editor", jobs.job.ID); err != nil {
		t.Fatal(err)
	}
	<-executor.cancelled
}

func TestExportCapturesSettingsForNextJob(t *testing.T) {
	jobs, executor := &jobsStub{}, &executorStub{started: make(chan struct{}), cancelled: make(chan struct{})}
	settings := store.NewRuntimeSettingsState(store.RuntimeSettings{ExportLimit: 1})
	useCase := NewExportUseCase(jobs, executor, 1)
	useCase.Settings = settings
	if _, err := useCase.Create(context.Background(), domain.Principal{Subject: "editor"}, "p_aaaaaaaaaaaa", project(), input()); err != nil {
		t.Fatal(err)
	}
	settings.Replace(store.RuntimeSettings{ExportLimit: 9})
	var request struct {
		Settings store.RuntimeSettings `json:"runtimeSettings"`
	}
	if err := json.Unmarshal([]byte(jobs.job.RequestJSON), &request); err != nil {
		t.Fatal(err)
	}
	if request.Settings.ExportLimit != 1 {
		t.Fatalf("captured export limit = %d, want 1", request.Settings.ExportLimit)
	}
	if err := useCase.Cancel(context.Background(), "editor", jobs.job.ID); err != nil {
		t.Fatal(err)
	}
	<-executor.cancelled
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
	record := store.ExportJob{ID: "j_aaaaaaaaaaaa", State: store.JobSucceeded, ResultJSON: sql.NullString{String: `{"outputName":"export.mkv","sizeBytes":42,"retainUntil":"` + retainUntil.Format(time.RFC3339) + `","appliedStrategies":[{"segment":1,"outputName":"export.mkv","strategy":"hybrid_smart_cut"},{"segment":2,"strategy":"stream_copy"}],"warnings":[{"message":"Cut may start at an earlier keyframe."}],"outputDir":"/exports/private","stderr":"secret"}`, Valid: true}}
	job := jobResult(record)
	if job.Result == nil || job.Result.OutputName != "export.mkv" || len(job.Result.OutputNames) != 0 || job.Result.SizeBytes != 42 || !job.Result.RetainUntil.Equal(retainUntil) || job.AppliedStrategy != "" || len(job.Result.AppliedStrategies) != 2 || job.Result.AppliedStrategies[0].OutputName != "export.mkv" || job.Result.AppliedStrategies[1].Segment != 2 || job.Result.AppliedStrategies[1].Strategy != "stream_copy" || len(job.Warnings) != 1 || job.Warnings[0] != "Cut may start at an earlier keyframe." || job.ErrorCode != nil {
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
	job = jobResult(store.ExportJob{ID: "j_aaaaaaaaaaaa", State: store.JobSucceeded, ResultJSON: sql.NullString{String: `{"outputName":"export.mkv","sizeBytes":1,"retainUntil":"2026-08-20T12:00:00Z","appliedStrategies":[{"segment":1,"outputName":"/exports/private.mkv","strategy":"stream_copy"}]}`, Valid: true}})
	if job.Result != nil {
		t.Fatalf("unsafe applied strategy leaked: %#v", job)
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
