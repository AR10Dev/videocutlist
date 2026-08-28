package store_test

import (
	"context"
	"database/sql"
	"errors"
	"testing"

	_ "modernc.org/sqlite"
	"videocutlist/infrastructure/store"
)

func TestJobStateTransitionsAndRecovery(t *testing.T) {
	db := openJobsDB(t)
	jobs, err := store.NewJobStore(db)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if _, err := jobs.Create(ctx, store.ExportJob{ID: "j_000000000101", OwnerLogin: "editor", ProjectID: "project", ProjectRevision: 1, RequestJSON: `{}`}); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"j_000000000102", "j_000000000103"} {
		if _, err := jobs.Create(ctx, store.ExportJob{ID: id, OwnerLogin: "editor", ProjectID: "project", ProjectRevision: 1, RequestJSON: `{}`}); err != nil {
			t.Fatal(err)
		}
		if _, err := jobs.Start(ctx, "editor", id); err != nil {
			t.Fatal(err)
		}
	}
	if count, err := jobs.Recover(ctx); err != nil || count != 2 {
		t.Fatalf("recover = %d, %v", count, err)
	}
	queued, err := jobs.Get(ctx, "editor", "j_000000000101")
	if err != nil || queued.State != store.JobQueued {
		t.Fatalf("queued job after recovery = %#v, %v", queued, err)
	}
	job, err := jobs.Get(ctx, "editor", "j_000000000102")
	if err != nil || job.State != store.JobFailed || job.ErrorCode.String != "interrupted_by_restart" {
		t.Fatalf("recovered job = %#v, %v", job, err)
	}
	if _, err := jobs.Start(ctx, "editor", "j_000000000102"); !errors.Is(err, store.ErrJobState) {
		t.Fatalf("terminal job restarted: %v", err)
	}
	if _, err := jobs.Create(ctx, store.ExportJob{ID: "j_000000000104", OwnerLogin: "editor", ProjectID: "project", ProjectRevision: 1, RequestJSON: `{}`}); err != nil {
		t.Fatal(err)
	}
	if _, err := jobs.Start(ctx, "editor", "j_000000000104"); err != nil {
		t.Fatal(err)
	}
	completed, err := jobs.Succeed(ctx, "editor", "j_000000000104", `{"outputName":"export.mkv","retainUntil":"2026-01-01T00:00:00Z"}`)
	if err != nil || completed.State != store.JobSucceeded || !completed.ResultJSON.Valid {
		t.Fatalf("completed job = %#v, %v", completed, err)
	}
}

func TestJobLookupIgnoresCompatibilityOwner(t *testing.T) {
	db := openJobsDB(t)
	jobs, _ := store.NewJobStore(db)
	ctx := context.Background()
	if _, err := jobs.Create(ctx, store.ExportJob{ID: "j_000000000105", OwnerLogin: "a", ProjectID: "project", ProjectRevision: 1, RequestJSON: `{}`}); err != nil {
		t.Fatal(err)
	}
	if _, err := jobs.Get(ctx, "b", "j_000000000105"); err != nil {
		t.Fatalf("single-user lookup = %v", err)
	}
}

func openJobsDB(t *testing.T) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	ctx := context.Background()
	if err := store.MigrateProjects(ctx, db); err != nil {
		t.Fatal(err)
	}
	if err := store.MigrateJobs(ctx, db); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO projects (id, revision, document_json, created_at, updated_at) VALUES ('project', 1, '{"schemaVersion":2,"name":"Project","items":[{"id":"i_aaaaaaaaaaaaaaaaaaaaaaaa","mediaId":"m_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","segments":[]}]}', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`); err != nil {
		t.Fatal(err)
	}
	return db
}
