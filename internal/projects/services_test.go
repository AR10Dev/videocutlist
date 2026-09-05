package projects

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

	"videocutlist/internal/db"
	jobqueue "videocutlist/internal/jobs"
	"videocutlist/internal/projects/model"
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
func (c *catalogStub) Preview(context.Context, PreviewSpec) (model.PreviewSpec, error) {
	return model.PreviewSpec{}, nil
}

func TestImportJobResultMapsPersistedRootStatuses(t *testing.T) {
	job := jobqueue.Job{
		ID: "j_scanresult1234", State: jobqueue.JobSucceeded,
		ResultJSON: sql.NullString{Valid: true, String: `{"library":{"state":"ready_with_media"},"empty":{"state":"ready_empty","errorCode":"scan_limit"}}`},
	}
	got := importJobResult(job)
	if got.Progress != 1 || got.RootResults["library"].State != LibraryReadyWithMedia || got.RootResults["empty"].ErrorCode != "scan_limit" {
		t.Fatalf("import result = %#v", got)
	}
}

type unifiedJobsStub struct{ job jobqueue.Job }

func (s unifiedJobsStub) Get(context.Context, string) (jobqueue.Job, error)    { return s.job, nil }
func (s unifiedJobsStub) Cancel(context.Context, string) (jobqueue.Job, error) { return s.job, nil }

func TestJobUseCaseMapsSafeScanResults(t *testing.T) {
	got, err := (JobUseCase{Jobs: unifiedJobsStub{job: jobqueue.Job{
		ID: "j_scanresult1234", Kind: jobqueue.JobScan, State: jobqueue.JobFailed,
		ErrorCode:  sql.NullString{Valid: true, String: "/tmp/private"},
		ResultJSON: sql.NullString{Valid: true, String: `{"library":{"state":"ready_with_media"},"../../secret":{"state":"failed","errorCode":"/tmp/root"},"bad":{"state":"unknown"}}`},
	}}}).Get(context.Background(), "j_scanresult1234")
	if err != nil {
		t.Fatal(err)
	}
	if len(got.RootResults) != 1 || got.RootResults["library"].State != LibraryReadyWithMedia || got.ErrorCode != nil {
		t.Fatalf("job = %#v", got)
	}
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
func (c *cancellableCatalog) Preview(context.Context, PreviewSpec) (model.PreviewSpec, error) {
	return model.PreviewSpec{}, nil
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
func (c *boundedRecoveryCatalog) Preview(context.Context, PreviewSpec) (model.PreviewSpec, error) {
	return model.PreviewSpec{}, nil
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
	revision int64
	document model.Document
}

func (p *projectsStub) Get(context.Context, string) (ProjectRecord, error) {
	return ProjectRecord{Document: p.document, Revision: p.revision, UpdatedAt: time.Now()}, nil
}
func (p *projectsStub) Save(_ context.Context, _ string, revision int64, document model.Document) (ProjectRecord, error) {
	if revision != p.revision {
		return ProjectRecord{}, store.ErrRevisionConflict
	}
	p.saves++
	p.revision++
	p.document = document
	return ProjectRecord{Document: document, Revision: p.revision, UpdatedAt: time.Now()}, nil
}

func TestProjectUseCaseSavesValidatedBatchAtomically(t *testing.T) {
	mediaID := "m_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	repository := &projectsStub{}
	catalog := &projectCatalogStub{media: map[string]Media{mediaID: {ID: mediaID, DurationMS: 1_000}}}
	useCase := ProjectUseCase{Repository: repository, Media: catalog}
	document := model.Document{SchemaVersion: model.ProjectSchemaVersion, Name: "Batch", Items: []model.ProjectItem{
		{ID: "i_aaaaaaaaaaaaaaaaaaaaaaaa", MediaID: mediaID, Segments: []model.Segment{{StartMS: 0, EndMS: 300}}, EditorState: &model.UIState{Zoom: 1}},
		{ID: "i_bbbbbbbbbbbbbbbbbbbbbbbb", MediaID: mediaID, Segments: []model.Segment{{StartMS: 400, EndMS: 900}}, ExportOptions: model.ExportOptions{Mode: "separate", Container: "mkv"}},
	}}
	ctx := t.Context()
	saved, err := useCase.Create(ctx, "p_aaaaaaaaaaaa", ProjectInput{Document: document})
	if err != nil || saved.Revision != 1 || repository.saves != 1 || len(saved.Items) != 2 {
		t.Fatalf("saved = %#v, err = %v, saves = %d", saved, err, repository.saves)
	}
	encoded, err := json.Marshal(saved)
	if err != nil || !strings.Contains(string(encoded), `"revision":1`) {
		t.Fatalf("project response = %s, err = %v", encoded, err)
	}
	if strings.Count(string(encoded), `"revision"`) != 1 {
		t.Fatalf("project response duplicates revision: %s", encoded)
	}
	next := ProjectInput{Revision: saved.Revision, Document: saved.Document}
	resaved, err := useCase.Save(ctx, "p_aaaaaaaaaaaa", next)
	if err != nil || resaved.Revision != 2 || repository.saves != 2 {
		t.Fatalf("sequential save = %#v, err = %v, saves = %d", resaved, err, repository.saves)
	}
	stale := ProjectInput{Document: saved.Document}
	if _, err := useCase.Create(ctx, "p_aaaaaaaaaaaa", stale); !errors.Is(err, store.ErrRevisionConflict) || repository.saves != 2 {
		t.Fatalf("duplicate create = %v, saves = %d", err, repository.saves)
	}
	bad := ProjectInput{Revision: resaved.Revision, Document: resaved.Document}
	bad.Items[1].Segments[0].EndMS = 1_001
	if _, err := useCase.Save(ctx, "p_aaaaaaaaaaaa", bad); err == nil || repository.saves != 2 {
		t.Fatalf("out-of-range save = %v, saves = %d", err, repository.saves)
	}
	bad.Items[1].Segments[0].EndMS = 900
	bad.Items[1].MediaID = "m_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	if _, err := useCase.Save(ctx, "p_aaaaaaaaaaaa", bad); err == nil {
		t.Fatalf("missing media save = %v, saves = %d", err, repository.saves)
	} else if itemErr, ok := errors.AsType[*ProjectItemError](err); !ok || itemErr.ItemID != bad.Items[1].ID || itemErr.Code != "media_unavailable" || repository.saves != 2 {
		t.Fatalf("missing media save = %v, saves = %d", err, repository.saves)
	}
	if got, err := useCase.Get(ctx, "p_aaaaaaaaaaaa"); err != nil || got.Revision != 2 || len(got.Items) != 2 {
		t.Fatalf("stored project = %#v, err = %v", got, err)
	}
}

type projectCatalogStub struct{ media map[string]Media }

func (c *projectCatalogStub) Get(_ context.Context, id string) (Media, error) {
	media, ok := c.media[id]
	if !ok {
		return Media{}, errors.New("media unavailable")
	}
	return media, nil
}
func (*projectCatalogStub) List(context.Context, string, int) (MediaPage, error) {
	return MediaPage{}, nil
}
func (*projectCatalogStub) Browse(context.Context, string, string, int) (FolderPage, error) {
	return FolderPage{}, nil
}
func (*projectCatalogStub) Refresh(context.Context) error { return nil }
func (*projectCatalogStub) Preview(context.Context, PreviewSpec) (model.PreviewSpec, error) {
	return model.PreviewSpec{}, nil
}

func TestJobUseCaseCancelsThroughUnifiedStore(t *testing.T) {
	db, err := store.OpenDatabase(context.Background(), t.TempDir()+"/jobs.db")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	jobs, err := jobqueue.NewJobsStore(db)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := jobs.Create(context.Background(), jobqueue.Job{ID: "j_aaaaaaaaaaaa", BatchID: "b_aaaaaaaaaaaa", Kind: jobqueue.JobScan, RequestJSON: `{}`}); err != nil {
		t.Fatal(err)
	}
	if err := (JobUseCase{Jobs: jobs}).Cancel(context.Background(), "j_aaaaaaaaaaaa"); err != nil {
		t.Fatal(err)
	}
	job, err := jobs.Get(context.Background(), "j_aaaaaaaaaaaa")
	if err != nil || job.State != jobqueue.JobCancelled {
		t.Fatalf("cancelled job = %#v, %v", job, err)
	}
}

func TestExportJobResultIsSafeAndStateCompatible(t *testing.T) {
	retainUntil := time.Date(2026, 8, 20, 12, 0, 0, 0, time.UTC)
	record := jobqueue.Job{ID: "j_aaaaaaaaaaaa", State: jobqueue.JobSucceeded, ResultJSON: sql.NullString{String: `{"outputName":"export.mkv","sizeBytes":42,"retainUntil":"` + retainUntil.Format(time.RFC3339) + `","appliedStrategies":[{"segment":1,"outputName":"export.mkv","strategy":"hybrid_smart_cut"},{"segment":2,"strategy":"stream_copy"}],"warnings":[{"message":"Cut may start at an earlier keyframe."}],"outputDir":"/exports/private","stderr":"secret"}`, Valid: true}}
	job := jobResult(record)
	if job.Result == nil || job.Result.OutputName != "export.mkv" || len(job.Result.OutputNames) != 0 || job.Result.SizeBytes != 42 || !job.Result.RetainUntil.Equal(retainUntil) || job.AppliedStrategy != "" || len(job.Result.AppliedStrategies) != 2 || job.Result.AppliedStrategies[0].OutputName != "export.mkv" || job.Result.AppliedStrategies[1].Segment != 2 || job.Result.AppliedStrategies[1].Strategy != "stream_copy" || len(job.Warnings) != 1 || job.Warnings[0] != "Cut may start at an earlier keyframe." || job.ErrorCode != nil {
		t.Fatalf("job = %#v", job)
	}

	failed := jobResult(jobqueue.Job{ID: record.ID, State: jobqueue.JobFailed, ErrorCode: sql.NullString{String: "media_unavailable", Valid: true}, ResultJSON: record.ResultJSON})
	if failed.Result != nil || len(failed.Warnings) != 0 || failed.ErrorCode == nil || *failed.ErrorCode != "media_unavailable" {
		t.Fatalf("failed job = %#v", failed)
	}
}

func TestExportJobMalformedResultFailsClosed(t *testing.T) {
	job := jobResult(jobqueue.Job{ID: "j_aaaaaaaaaaaa", State: jobqueue.JobSucceeded, ResultJSON: sql.NullString{String: `{"outputName":"/exports/private.mkv","warnings":[`, Valid: true}})
	if job.Result != nil || len(job.Warnings) != 0 {
		t.Fatalf("malformed result leaked: %#v", job)
	}
	job = jobResult(jobqueue.Job{ID: "j_aaaaaaaaaaaa", State: jobqueue.JobSucceeded, ResultJSON: sql.NullString{String: `{"outputName":"/exports/private.mkv","sizeBytes":1,"retainUntil":"2026-08-20T12:00:00Z","warnings":[{"message":"secret"}]}`, Valid: true}})
	if job.Result != nil || len(job.Warnings) != 0 {
		t.Fatalf("unsafe result leaked: %#v", job)
	}
	job = jobResult(jobqueue.Job{ID: "j_aaaaaaaaaaaa", State: jobqueue.JobSucceeded, ResultJSON: sql.NullString{String: `{"outputName":"export.mkv","sizeBytes":1,"retainUntil":"2026-08-20T12:00:00Z","appliedStrategies":[{"segment":1,"outputName":"/exports/private.mkv","strategy":"stream_copy"}]}`, Valid: true}})
	if job.Result != nil {
		t.Fatalf("unsafe applied strategy leaked: %#v", job)
	}
	for _, name := range []string{".", "..", "C:export.mkv", "dir/export.mkv", `dir\\export.mkv`, "export\x00.mkv", strings.Repeat("x", 256)} {
		job = jobResult(jobqueue.Job{ID: "j_aaaaaaaaaaaa", State: jobqueue.JobSucceeded, ResultJSON: sql.NullString{String: `{"outputName":` + strconv.Quote(name) + `,"sizeBytes":1,"retainUntil":"2026-08-20T12:00:00Z","warnings":[{"message":"secret"}]}`, Valid: true}})
		if job.Result != nil || len(job.Warnings) != 0 {
			t.Fatalf("unsafe %q leaked: %#v", name, job)
		}
	}

	message := strings.Repeat("x", 501)
	job = jobResult(jobqueue.Job{ID: "j_aaaaaaaaaaaa", State: jobqueue.JobSucceeded, ResultJSON: sql.NullString{String: `{"outputName":"export.mkv","sizeBytes":1,"retainUntil":"2026-08-20T12:00:00Z","warnings":[{"message":"` + message + `"}]}`, Valid: true}})
	if len(job.Warnings) != 1 || len(job.Warnings[0]) != 500 {
		t.Fatalf("warnings = %#v", job.Warnings)
	}
}

func stringPtr(value string) *string { return &value }
