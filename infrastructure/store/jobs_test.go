package store_test

import (
	"context"
	"errors"
	"sync"
	"testing"

	"videocutlist/infrastructure/store"
)

func TestUnifiedJobsTransitionsAndDerivedBatch(t *testing.T) {
	db, err := store.OpenDatabase(context.Background(), t.TempDir()+"/jobs.db")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	jobs, err := store.NewJobsStore(db)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	job, err := jobs.Create(ctx, store.Job{ID: "j_one", BatchID: "b_one", Kind: store.JobExport, ProjectID: "p_one", ProjectItemID: "i_one", RequestJSON: `{"mediaId":"m_safe"}`})
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
	state, progress, err := jobs.Batch(ctx, "b_one")
	if err != nil || state != store.JobSucceeded || progress != 1 {
		t.Fatalf("batch = %q, %v, %v", state, progress, err)
	}
	if _, err = jobs.Create(ctx, store.Job{ID: "j_scan", BatchID: "b_scan", Kind: store.JobScan, RequestJSON: `{"root":"camera"}`}); err != nil {
		t.Fatal(err)
	}
	if _, err = jobs.Create(ctx, store.Job{ID: "j_bad", BatchID: "b_bad", Kind: store.JobScan, ProjectID: "p", RequestJSON: `{}`}); err == nil {
		t.Fatal("scan project reference accepted")
	}
}

func TestUnifiedJobsCancellationFailureAndRestartRecovery(t *testing.T) {
	db, err := store.OpenDatabase(context.Background(), t.TempDir()+"/jobs.db")
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
		{ID: "j_queued", BatchID: "b_queued", Kind: store.JobScan, RequestJSON: `{}`},
		{ID: "j_failed", BatchID: "b_failed", Kind: store.JobScan, RequestJSON: `{}`},
		{ID: "j_restarted_export", BatchID: "b_export", Kind: store.JobExport, ProjectID: "p", ProjectItemID: "i", RequestJSON: `{}`},
		{ID: "j_restarted_detect", BatchID: "b_detect", Kind: store.JobDetect, ProjectID: "p", ProjectItemID: "i", RequestJSON: `{}`},
	} {
		if _, err := jobs.Create(ctx, job); err != nil {
			t.Fatal(err)
		}
	}
	if job, err := jobs.Cancel(ctx, "j_queued"); err != nil || job.State != store.JobCancelled {
		t.Fatalf("queued cancel = %#v, %v", job, err)
	}
	if _, err := jobs.Start(ctx, "j_failed"); err != nil {
		t.Fatal(err)
	}
	if job, err := jobs.Fail(ctx, "j_failed", "failed"); err != nil || job.State != store.JobFailed || !job.ErrorCode.Valid || job.ErrorCode.String != "failed" {
		t.Fatalf("running failure = %#v, %v", job, err)
	}
	for _, id := range []string{"j_restarted_export", "j_restarted_detect"} {
		if _, err := jobs.Start(ctx, id); err != nil {
			t.Fatal(err)
		}
	}
	if recovered, err := jobs.Recover(ctx); err != nil || recovered != 2 {
		t.Fatalf("recovery = %d, %v", recovered, err)
	}
	for _, id := range []string{"j_restarted_export", "j_restarted_detect"} {
		if job, err := jobs.Get(ctx, id); err != nil || job.State != store.JobFailed || !job.ErrorCode.Valid || job.ErrorCode.String != "interrupted_by_restart" {
			t.Fatalf("recovered job = %#v, %v", job, err)
		}
	}
}

func TestUnifiedJobsConcurrentTerminalTransitions(t *testing.T) {
	db, err := store.OpenDatabase(context.Background(), t.TempDir()+"/jobs.db")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	jobs, _ := store.NewJobsStore(db)
	ctx := context.Background()
	if _, err := jobs.Create(ctx, store.Job{ID: "j_race", BatchID: "b_race", Kind: store.JobDetect, ProjectID: "p", ProjectItemID: "i", RequestJSON: `{"kind":"scene"}`}); err != nil {
		t.Fatal(err)
	}
	if _, err := jobs.Start(ctx, "j_race"); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	results := make(chan error, 3)
	for _, fn := range []func() (store.Job, error){func() (store.Job, error) { return jobs.Succeed(ctx, "j_race", `{}`) }, func() (store.Job, error) { return jobs.Fail(ctx, "j_race", "failed") }, func() (store.Job, error) { return jobs.Cancel(ctx, "j_race") }} {
		wg.Add(1)
		go func(fn func() (store.Job, error)) { defer wg.Done(); _, err := fn(); results <- err }(fn)
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
	job, err := jobs.Get(ctx, "j_race")
	if err != nil || job.State == store.JobRunning {
		t.Fatalf("final = %#v, %v", job, err)
	}
}
