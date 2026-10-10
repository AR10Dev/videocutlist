package media

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"testing"
	testsupport "videocutlist/internal/testsupport"

	dbstore "videocutlist/internal/db"
	jobservice "videocutlist/internal/jobs"
	jobs "videocutlist/internal/jobs/model"
)

func TestImportJobResultMapsPersistedRootStatuses(t *testing.T) {
	job := jobs.Job{ID: "j_scanresult1234", State: jobs.JobSucceeded,
		ResultJSON: sql.NullString{Valid: true, String: `{"library":{"state":"ready_with_media"},"empty":{"state":"ready_empty","errorCode":"scan_limit"}}`}}
	got := ImportJobResult(job)
	if got.Progress != 1 || got.RootResults["library"].State != LibraryReadyWithMedia || got.RootResults["empty"].ErrorCode != "scan_limit" || got.Indexed != 0 || len(got.ValidationErrors) != 0 {
		t.Fatalf("import result = %#v", got)
	}
}

func TestImportJobResultSanitizesUnsafePersistedFields(t *testing.T) {
	got := ImportJobResult(jobs.Job{ID: "j_scanresult1234", State: jobs.JobRunning,
		ErrorCode:  sql.NullString{Valid: true, String: "/private/path"},
		ResultJSON: sql.NullString{Valid: true, String: `{"library":{"state":"ready_with_media"},"../../secret":{"state":"failed","errorCode":"/tmp/root"},"bad":{"state":"unknown"}}`}})
	if got.Progress != 0 || got.ErrorCode != "" || len(got.RootResults) != 1 || got.RootResults["library"].State != LibraryReadyWithMedia {
		t.Fatalf("unsafe result projection = %#v", got)
	}
}

func TestImportCommandReplaysAcrossRestart(t *testing.T) {
	ctx := t.Context()
	path := t.TempDir() + "/jobs.db"
	database, err := dbstore.OpenDatabase(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	store, err := testsupport.NewJobsStore(database)
	if err != nil {
		t.Fatal(err)
	}
	scheduler, err := jobservice.NewScheduler(store, jobservice.SchedulerConfig{QueueCapacity: 4, WorkerLimit: 1}, func(context.Context, jobs.Job) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	useCase := &ImportUseCase{Configured: true, Scheduler: scheduler, UnifiedJobs: store}
	first, err := useCase.StartImport(ctx, "library-key")
	if err != nil {
		t.Fatal(err)
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := dbstore.OpenDatabase(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := reopened.Close(); err != nil {
			t.Error(err)
		}
	}()
	reopenedStore, err := testsupport.NewJobsStore(reopened)
	if err != nil {
		t.Fatal(err)
	}
	reopenedScheduler, err := jobservice.NewScheduler(reopenedStore, jobservice.SchedulerConfig{QueueCapacity: 4, WorkerLimit: 1}, func(context.Context, jobs.Job) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	replayed, err := (&ImportUseCase{Configured: true, Scheduler: reopenedScheduler, UnifiedJobs: reopenedStore}).StartImport(ctx, "library-key")
	if err != nil || replayed.ID != first.ID {
		t.Fatalf("replayed = %#v, want original %#v, err=%v", replayed, first, err)
	}
	job, err := reopenedStore.Get(ctx, first.ID)
	if err != nil || job.RequestJSON != `{}` {
		t.Fatalf("persisted request = %q err=%v", job.RequestJSON, err)
	}
}

func TestImportStatusAndCancellationLifecycle(t *testing.T) {
	ctx := t.Context()
	database, err := dbstore.OpenDatabase(ctx, t.TempDir()+"/jobs.db")
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := database.Close(); err != nil {
			t.Error(err)
		}
	}()
	store, err := testsupport.NewJobsStore(database)
	if err != nil {
		t.Fatal(err)
	}
	scheduler, err := jobservice.NewScheduler(store, jobservice.SchedulerConfig{QueueCapacity: 4, WorkerLimit: 1}, func(context.Context, jobs.Job) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := scheduler.Shutdown(context.Background()); err != nil {
			t.Error(err)
		}
	}()
	useCase := &ImportUseCase{Configured: true, Scheduler: scheduler, UnifiedJobs: store}

	queued, err := useCase.StartImport(ctx, "queued-scan")
	if err != nil {
		t.Fatal(err)
	}
	status, err := useCase.ImportStatus(ctx, queued.ID)
	if err != nil || status.State != string(jobs.JobQueued) || status.Progress != 0 {
		t.Fatalf("queued import status = %#v, err=%v", status, err)
	}

	otherKind, err := store.Create(ctx, jobs.Job{
		ID: "j_export0000001", BatchID: "b_export0000001", Kind: jobs.JobExport,
		ProjectID: "p_project", ProjectItemID: "i_item", RequestJSON: `{}`,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := useCase.ImportStatus(ctx, otherKind.ID); !errors.Is(err, jobs.ErrJobNotFound) {
		t.Fatalf("wrong-kind import status error = %v, want ErrJobNotFound", err)
	}
	if err := useCase.CancelImport(ctx, otherKind.ID); !errors.Is(err, jobs.ErrJobNotFound) {
		t.Fatalf("wrong-kind import cancel error = %v, want ErrJobNotFound", err)
	}
	unchanged, err := store.Get(ctx, otherKind.ID)
	if err != nil || unchanged.State != jobs.JobQueued {
		t.Fatalf("wrong-kind cancellation changed job state to %q, err=%v", unchanged.State, err)
	}

	if err := useCase.CancelImport(ctx, queued.ID); err != nil {
		t.Fatalf("cancel queued import: %v", err)
	}
	cancelled, err := useCase.ImportStatus(ctx, queued.ID)
	if err != nil || cancelled.State != string(jobs.JobCancelled) || cancelled.Progress != 0 {
		t.Fatalf("cancelled import status = %#v, err=%v", cancelled, err)
	}
	if err := useCase.CancelImport(ctx, queued.ID); err != nil {
		t.Fatalf("cancel already-terminal import: %v", err)
	}

	succeeded, err := useCase.StartImport(ctx, "succeeded-scan")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Start(ctx, succeeded.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Succeed(ctx, succeeded.ID, `{"library":{"state":"ready_with_media"}}`); err != nil {
		t.Fatal(err)
	}
	status, err = useCase.ImportStatus(ctx, succeeded.ID)
	if err != nil || status.State != string(jobs.JobSucceeded) || status.Progress != 1 {
		t.Fatalf("succeeded import status = %#v, err=%v", status, err)
	}
	if err := useCase.CancelImport(ctx, succeeded.ID); err != nil {
		t.Fatalf("cancel succeeded terminal import: %v", err)
	}
}

func TestImportCapacityFailureLeavesNoCommandRecord(t *testing.T) {
	ctx := t.Context()
	database, err := dbstore.OpenDatabase(ctx, t.TempDir()+"/jobs.db")
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := database.Close(); err != nil {
			t.Error(err)
		}
	}()
	store, err := testsupport.NewJobsStore(database)
	if err != nil {
		t.Fatal(err)
	}
	scheduler, err := jobservice.NewScheduler(store, jobservice.SchedulerConfig{QueueCapacity: 1, WorkerLimit: 1}, func(context.Context, jobs.Job) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	useCase := &ImportUseCase{Configured: true, Scheduler: scheduler, UnifiedJobs: store}
	if _, err := useCase.StartImport(ctx, "accepted-scan"); err != nil {
		t.Fatal(err)
	}
	if _, err := useCase.StartImport(ctx, "capacity-scan"); !errors.Is(err, jobs.ErrQueueFull) {
		t.Fatalf("full queue error = %v", err)
	}
	digest := sha256.Sum256([]byte(`{}`))
	_, found, err := scheduler.LookupCommand(ctx, jobs.CommandAdmission{Key: "capacity-scan", Scope: "library-scan", Kind: "library-scan", Target: "library", Digest: hex.EncodeToString(digest[:])})
	if err != nil || found {
		t.Fatalf("failed admission record found=%v err=%v", found, err)
	}
}
