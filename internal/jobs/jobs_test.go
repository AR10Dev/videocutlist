package jobs_test

import (
	"context"
	"errors"
	"sync"
	"testing"

	db "videocutlist/internal/db"
	store "videocutlist/internal/jobs"
)

func TestUnifiedJobsTransitionsAndDerivedBatch(t *testing.T) {
	db, err := db.OpenDatabase(context.Background(), t.TempDir()+"/jobs.db")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	jobs, err := store.NewJobsStore(db)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	job, err := jobs.Create(ctx, store.Job{ID: "j_000000000001", BatchID: "b_000000000001", Kind: store.JobExport, ProjectID: "p_one", ProjectItemID: "i_one", RequestJSON: `{"mediaId":"m_safe"}`})
	if err != nil || job.State != store.JobQueued {
		t.Fatalf("create = %#v, %v", job, err)
	}
	if _, err = jobs.Succeed(ctx, job.ID, `{}`); !errors.Is(err, store.ErrJobState) {
		t.Fatalf("queued succeed = %v", err)
	}
	if _, err = jobs.Start(ctx, job.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = jobs.Succeed(ctx, job.ID, `{"outputName":"clip.mkv"}`); err != nil {
		t.Fatal(err)
	}
	state, progress, err := jobs.Batch(ctx, "b_000000000001")
	if err != nil || state != store.JobSucceeded || progress != 1 {
		t.Fatalf("batch = %q, %v, %v", state, progress, err)
	}
	if _, err = jobs.Create(ctx, store.Job{ID: "j_000000000002", BatchID: "b_000000000002", Kind: store.JobScan, RequestJSON: `{"root":"camera"}`}); err != nil {
		t.Fatal(err)
	}
	batchIDs, err := jobs.ListBatchIDs(ctx, store.JobExport, 10)
	if err != nil || len(batchIDs) != 1 || batchIDs[0] != job.BatchID {
		t.Fatalf("export batch IDs = %v, %v", batchIDs, err)
	}
	if _, err = jobs.Create(ctx, store.Job{ID: "j_000000000003", BatchID: "b_000000000003", Kind: store.JobScan, ProjectID: "p", RequestJSON: `{}`}); err == nil {
		t.Fatal("scan project reference accepted")
	}
}

func TestUnifiedJobsPersistPerRootScanResults(t *testing.T) {
	db, err := db.OpenDatabase(context.Background(), t.TempDir()+"/scan.db")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	jobs, err := store.NewJobsStore(db)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	created, err := jobs.Create(ctx, store.Job{ID: "j_scanresults01", BatchID: "b_scanresults01", Kind: store.JobScan, RequestJSON: `{}`})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = jobs.Start(ctx, created.ID); err != nil {
		t.Fatal(err)
	}
	result := `{"camera":{"state":"ready_with_media"},"archive":{"state":"failed","errorCode":"scan_limit"}}`
	if _, err = jobs.Succeed(ctx, created.ID, result); err != nil {
		t.Fatal(err)
	}
	got, err := jobs.Get(ctx, created.ID)
	if err != nil || !got.ResultJSON.Valid || got.ResultJSON.String != result {
		t.Fatalf("scan result = %#v, %v", got.ResultJSON, err)
	}
}

func TestUnifiedJobsFailWithResultPersistsPartialScan(t *testing.T) {
	db, err := db.OpenDatabase(context.Background(), t.TempDir()+"/failed-scan.db")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	jobs, err := store.NewJobsStore(db)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	created, err := jobs.Create(ctx, store.Job{ID: "j_failedscan001", BatchID: "b_failedscan001", Kind: store.JobScan, RequestJSON: `{}`})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = jobs.Start(ctx, created.ID); err != nil {
		t.Fatal(err)
	}
	result := `{"good":{"state":"ready_with_media"},"bad":{"state":"failed","errorCode":"scan_failed"}}`
	got, err := jobs.FailWithResult(ctx, created.ID, result, "scan_failed")
	if err != nil || got.State != store.JobFailed || got.ResultJSON.String != result || got.ErrorCode.String != "scan_failed" {
		t.Fatalf("failed scan = %#v, %v", got, err)
	}
}

func TestUnifiedJobsCreateValidatesOpaqueIDs(t *testing.T) {
	db, err := db.OpenDatabase(context.Background(), t.TempDir()+"/jobs.db")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	jobs, err := store.NewJobsStore(db)
	if err != nil {
		t.Fatal(err)
	}
	valid := store.Job{ID: "j_aaaaaaaaaaaa", BatchID: "b_aaaaaaaaaaaa", Kind: store.JobScan, RequestJSON: `{}`}
	if _, err := jobs.Create(context.Background(), valid); err != nil {
		t.Fatalf("valid IDs rejected: %v", err)
	}
	for _, invalid := range []store.Job{
		{ID: "invalid", BatchID: valid.BatchID, Kind: valid.Kind, RequestJSON: valid.RequestJSON},
		{ID: valid.ID, BatchID: "invalid", Kind: valid.Kind, RequestJSON: valid.RequestJSON},
	} {
		if _, err := jobs.Create(context.Background(), invalid); err == nil {
			t.Fatalf("invalid IDs accepted: %#v", invalid)
		}
	}
}

func TestUnifiedJobsCancellationFailureAndRestartRecovery(t *testing.T) {
	db, err := db.OpenDatabase(context.Background(), t.TempDir()+"/jobs.db")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	jobs, err := store.NewJobsStore(db)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	for _, job := range []store.Job{
		{ID: "j_000000000004", BatchID: "b_000000000004", Kind: store.JobScan, RequestJSON: `{}`},
		{ID: "j_000000000005", BatchID: "b_000000000005", Kind: store.JobScan, RequestJSON: `{}`},
		{ID: "j_000000000006", BatchID: "b_000000000006", Kind: store.JobExport, ProjectID: "p", ProjectItemID: "i", RequestJSON: `{}`},
		{ID: "j_000000000007", BatchID: "b_000000000007", Kind: store.JobDetect, ProjectID: "p", ProjectItemID: "i", RequestJSON: `{}`},
	} {
		if _, err := jobs.Create(ctx, job); err != nil {
			t.Fatal(err)
		}
	}
	if job, err := jobs.Cancel(ctx, "j_000000000004"); err != nil || job.State != store.JobCancelled {
		t.Fatalf("queued cancel = %#v, %v", job, err)
	}
	if _, err := jobs.Start(ctx, "j_000000000005"); err != nil {
		t.Fatal(err)
	}
	if job, err := jobs.Fail(ctx, "j_000000000005", "failed"); err != nil || job.State != store.JobFailed || !job.ErrorCode.Valid || job.ErrorCode.String != "failed" {
		t.Fatalf("running failure = %#v, %v", job, err)
	}
	for _, id := range []string{"j_000000000006", "j_000000000007"} {
		if _, err := jobs.Start(ctx, id); err != nil {
			t.Fatal(err)
		}
	}
	if recovered, err := jobs.Recover(ctx); err != nil || recovered != 2 {
		t.Fatalf("recovery = %d, %v", recovered, err)
	}
	for _, id := range []string{"j_000000000006", "j_000000000007"} {
		if job, err := jobs.Get(ctx, id); err != nil || job.State != store.JobFailed || !job.ErrorCode.Valid || job.ErrorCode.String != "interrupted_by_restart" {
			t.Fatalf("recovered job = %#v, %v", job, err)
		}
	}
}

func TestUnifiedJobsConcurrentTerminalTransitions(t *testing.T) {
	db, err := db.OpenDatabase(t.Context(), t.TempDir()+"/jobs.db")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	jobs, _ := store.NewJobsStore(db)
	ctx := t.Context()
	if _, err := jobs.Create(ctx, store.Job{ID: "j_000000000008", BatchID: "b_000000000008", Kind: store.JobDetect, ProjectID: "p", ProjectItemID: "i", RequestJSON: `{"kind":"scene"}`}); err != nil {
		t.Fatal(err)
	}
	if _, err := jobs.Start(ctx, "j_000000000008"); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	results := make(chan error, 3)
	for _, fn := range []func() (store.Job, error){func() (store.Job, error) { return jobs.Succeed(ctx, "j_000000000008", `{}`) }, func() (store.Job, error) { return jobs.Fail(ctx, "j_000000000008", "failed") }, func() (store.Job, error) { return jobs.Cancel(ctx, "j_000000000008") }} {
		wg.Go(func() { _, err := fn(); results <- err })
	}
	wg.Wait()
	close(results)
	success := 0
	for err := range results {
		if err == nil {
			success++
		} else if !errors.Is(err, store.ErrJobState) {
			t.Fatalf("transition = %v", err)
		}
	}
	if success != 1 {
		t.Fatalf("terminal winners = %d", success)
	}
	job, err := jobs.Get(ctx, "j_000000000008")
	if err != nil || job.State == store.JobRunning {
		t.Fatalf("final = %#v, %v", job, err)
	}
}
