package jobs

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"sync"
	"testing"

	_ "modernc.org/sqlite"
)

func TestMigrateCommandAdmissionsPreservesExistingJobs(t *testing.T) {
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "legacy.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := db.Close(); err != nil {
			t.Error(err)
		}
	}()
	_, err = db.Exec(`CREATE TABLE jobs (id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, kind TEXT NOT NULL, project_id TEXT, project_item_id TEXT, proposal_id TEXT, credential_id TEXT, state TEXT NOT NULL, request_json TEXT NOT NULL, result_json TEXT, error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
		INSERT INTO jobs (id,batch_id,kind,state,request_json,created_at,updated_at) VALUES ('j_000000000100','b_000000000100','library_scan','queued','{}','2025-01-01T00:00:00Z','2025-01-01T00:00:00Z');`)
	if err != nil {
		t.Fatal(err)
	}
	if err := Migrate(t.Context(), db); err != nil {
		t.Fatal(err)
	}
	store, err := NewJobsStore(db)
	if err != nil {
		t.Fatal(err)
	}
	job, err := store.Get(t.Context(), "j_000000000100")
	if err != nil || job.State != JobQueued {
		t.Fatalf("legacy job = %#v, err = %v", job, err)
	}
	var admissions int
	if err := db.QueryRowContext(t.Context(), `SELECT COUNT(*) FROM command_admissions`).Scan(&admissions); err != nil || admissions != 0 {
		t.Fatalf("new admission rows = %d, err = %v", admissions, err)
	}
}

func TestSchedulerCommandAdmissionIsAtomicIdempotentAndDurable(t *testing.T) {
	path := filepath.Join(t.TempDir(), "jobs.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	if err := Migrate(t.Context(), db); err != nil {
		t.Fatal(err)
	}
	store, err := NewJobsStore(db)
	if err != nil {
		t.Fatal(err)
	}
	scheduler, err := NewScheduler(store, SchedulerConfig{QueueCapacity: 2, WorkerLimit: 1}, func(context.Context, Job) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	command := CommandAdmission{Key: "request_key-1", Scope: "export", Kind: "submit", Target: "p_project", Digest: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}
	admitted := []Job{{ID: "j_000000000101", BatchID: "b_000000000101", Kind: JobScan, RequestJSON: `{}`}}

	const deliveries = 8
	var wg sync.WaitGroup
	results := make(chan CommandAdmissionResult, deliveries)
	errs := make(chan error, deliveries)
	for range deliveries {
		wg.Go(func() {
			result, err := scheduler.SubmitCommand(t.Context(), command, admitted)
			results <- result
			errs <- err
		})
	}
	wg.Wait()
	close(results)
	close(errs)
	created := 0
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	for result := range results {
		if len(result.Jobs) != 1 || result.Jobs[0].ID != admitted[0].ID || result.Jobs[0].Revision != 1 {
			t.Fatalf("admission result = %#v", result)
		}
		if !result.Replayed {
			created++
		}
	}
	if created != 1 {
		t.Fatalf("new admissions = %d, want exactly one", created)
	}

	command.Digest = "1123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	if _, err := scheduler.SubmitCommand(t.Context(), command, admitted); !errors.Is(err, ErrAdmissionConflict) {
		t.Fatalf("changed digest = %v, want ErrAdmissionConflict", err)
	}
	command.Digest = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	duplicateID := []Job{{ID: admitted[0].ID, BatchID: "b_000000000102", Kind: JobScan, RequestJSON: `{}`}}
	failed := command
	failed.Key = "rollback_key"
	if _, err := scheduler.SubmitCommand(t.Context(), failed, duplicateID); err == nil {
		t.Fatal("duplicate job insert succeeded")
	}
	full := command
	full.Key = "capacity_key"
	capacityJobs := []Job{
		{ID: "j_000000000102", BatchID: "b_000000000102", Kind: JobScan, RequestJSON: `{}`},
		{ID: "j_000000000103", BatchID: "b_000000000102", Kind: JobScan, RequestJSON: `{}`},
	}
	if _, err := scheduler.SubmitCommand(t.Context(), full, capacityJobs); !errors.Is(err, ErrQueueFull) {
		t.Fatalf("over-capacity command = %v, want ErrQueueFull", err)
	}
	var records int
	if err := db.QueryRowContext(t.Context(), `SELECT COUNT(*) FROM command_admissions WHERE idempotency_key IN (?,?)`, failed.Key, full.Key).Scan(&records); err != nil || records != 0 {
		t.Fatalf("failed command records = %d, err = %v", records, err)
	}
	if err := scheduler.Shutdown(t.Context()); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	db, err = sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := db.Close(); err != nil {
			t.Error(err)
		}
	}()
	db.SetMaxOpenConns(1)
	if err := Migrate(t.Context(), db); err != nil {
		t.Fatal(err)
	}
	store, err = NewJobsStore(db)
	if err != nil {
		t.Fatal(err)
	}
	scheduler, err = NewScheduler(store, SchedulerConfig{QueueCapacity: 1, WorkerLimit: 1}, func(context.Context, Job) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := scheduler.Shutdown(t.Context()); err != nil {
			t.Error(err)
		}
	}()
	result, err := scheduler.SubmitCommand(t.Context(), command, []Job{{ID: "j_ignored_replay", BatchID: "b_ignored_replay", Kind: JobScan, RequestJSON: `{}`}})
	if err != nil || !result.Replayed || len(result.Jobs) != 1 || result.Jobs[0].ID != admitted[0].ID {
		t.Fatalf("reopened admission = %#v, %v", result, err)
	}
}
