package media

import (
	"context"
	"errors"
	"testing"
	testsupport "videocutlist/internal/testsupport"

	dbstore "videocutlist/internal/db"
	jobservice "videocutlist/internal/jobs"
	jobs "videocutlist/internal/jobs/model"
	"videocutlist/internal/library/media/index"
	"videocutlist/internal/preview"
)

type scanTestCatalog struct {
	refreshErr   error
	refreshCalls int
	statuses     map[string]index.RootStatus
}

func (c *scanTestCatalog) List(context.Context, string, int) (MediaPage, error) {
	return MediaPage{}, nil
}
func (c *scanTestCatalog) Browse(context.Context, string, string, int) (FolderPage, error) {
	return FolderPage{}, nil
}
func (c *scanTestCatalog) Get(context.Context, string) (Media, error) { return Media{}, nil }
func (c *scanTestCatalog) Refresh(context.Context) error {
	c.refreshCalls++
	return c.refreshErr
}
func (c *scanTestCatalog) Preview(context.Context, preview.PreviewSpec) (preview.TranscodeSpec, error) {
	return preview.TranscodeSpec{}, nil
}
func (c *scanTestCatalog) RootStatuses() map[string]index.RootStatus { return c.statuses }

func newRunningScanJob(t *testing.T, ctx context.Context, store *jobservice.JobsStore, id string) jobs.Job {
	t.Helper()
	created, err := store.Create(ctx, jobs.Job{
		ID: id, BatchID: "b_" + id[len("j_"):], Kind: jobs.JobScan, RequestJSON: `{}`,
	})
	if err != nil {
		t.Fatal(err)
	}
	started, err := store.Start(ctx, created.ID)
	if err != nil {
		t.Fatal(err)
	}
	return started
}

func newScanTestJobs(t *testing.T) *jobservice.JobsStore {
	t.Helper()
	database, err := dbstore.OpenDatabase(t.Context(), t.TempDir()+"/scan.db")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := database.Close(); err != nil {
			t.Error(err)
		}
	})
	store, err := testsupport.NewJobsStore(database)
	if err != nil {
		t.Fatal(err)
	}
	return store
}

func TestScanExecutorPersistsSuccessfulRefreshAndRootStatuses(t *testing.T) {
	ctx := t.Context()
	store := newScanTestJobs(t)
	job := newRunningScanJob(t, ctx, store, "j_scanexecutor01")
	catalog := &scanTestCatalog{statuses: map[string]index.RootStatus{
		"archive": {State: "failed", ErrorCode: "scan_limit"},
		"camera":  {State: "ready_with_media"},
	}}
	executor := ScanExecutor{Jobs: store, Media: &MediaUseCase{Catalog: catalog, Configured: true}, Catalog: catalog}

	if err := executor.Run(ctx, job); err != nil {
		t.Fatalf("run scan executor: %v", err)
	}
	got, err := store.Get(ctx, job.ID)
	if err != nil {
		t.Fatal(err)
	}
	wantResult := `{"archive":{"state":"failed","errorCode":"scan_limit"},"camera":{"state":"ready_with_media"}}`
	if catalog.refreshCalls != 1 || got.State != jobs.JobSucceeded || !got.ResultJSON.Valid || got.ResultJSON.String != wantResult || got.ErrorCode.Valid {
		t.Fatalf("successful scan calls=%d job=%#v, want succeeded result %s", catalog.refreshCalls, got, wantResult)
	}
}

func TestScanExecutorPersistsPartialResultsAndFailureCode(t *testing.T) {
	ctx := t.Context()
	store := newScanTestJobs(t)
	job := newRunningScanJob(t, ctx, store, "j_scanexecutor02")
	refreshErr := errors.New("refresh failed")
	catalog := &scanTestCatalog{refreshErr: refreshErr, statuses: map[string]index.RootStatus{
		"archive": {State: "ready_empty"},
		"camera":  {State: "failed", ErrorCode: "permission_denied"},
	}}
	executor := ScanExecutor{Jobs: store, Media: &MediaUseCase{Catalog: catalog, Configured: true}, Catalog: catalog}

	if err := executor.Run(ctx, job); !errors.Is(err, refreshErr) {
		t.Fatalf("run error = %v, want refresh error", err)
	}
	got, err := store.Get(ctx, job.ID)
	if err != nil {
		t.Fatal(err)
	}
	wantResult := `{"archive":{"state":"ready_empty"},"camera":{"state":"failed","errorCode":"permission_denied"}}`
	if catalog.refreshCalls != 1 || got.State != jobs.JobFailed || !got.ResultJSON.Valid || got.ResultJSON.String != wantResult || !got.ErrorCode.Valid || got.ErrorCode.String != "scan_failed" {
		t.Fatalf("failed scan calls=%d job=%#v, want failed code scan_failed result %s", catalog.refreshCalls, got, wantResult)
	}
}

func TestScanExecutorJoinsRefreshAndTerminalTransitionErrors(t *testing.T) {
	ctx := t.Context()
	store := newScanTestJobs(t)
	job := newRunningScanJob(t, ctx, store, "j_scanexecutor03")
	originalResult := `{"camera":{"state":"ready_with_media"}}`
	if _, err := store.Succeed(ctx, job.ID, originalResult); err != nil {
		t.Fatal(err)
	}
	refreshErr := errors.New("refresh failed")
	catalog := &scanTestCatalog{refreshErr: refreshErr, statuses: map[string]index.RootStatus{
		"camera": {State: "failed", ErrorCode: "scan_failed"},
	}}
	executor := ScanExecutor{Jobs: store, Media: &MediaUseCase{Catalog: catalog, Configured: true}, Catalog: catalog}

	err := executor.Run(ctx, job)
	if !errors.Is(err, refreshErr) || !errors.Is(err, jobs.ErrJobState) {
		t.Fatalf("run error = %v, want refresh error and ErrJobState", err)
	}
	got, err := store.Get(ctx, job.ID)
	if err != nil {
		t.Fatal(err)
	}
	if catalog.refreshCalls != 1 || got.State != jobs.JobSucceeded || !got.ResultJSON.Valid || got.ResultJSON.String != originalResult || got.ErrorCode.Valid {
		t.Fatalf("terminal scan calls=%d job=%#v, want original success unchanged", catalog.refreshCalls, got)
	}
}
