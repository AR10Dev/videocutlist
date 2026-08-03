package store_test

import (
	"context"
	"database/sql"
	"errors"
	"testing"

	"editapp/infrastructure/store"
	_ "modernc.org/sqlite"
)

func TestJobStateTransitionsAndRecovery(t *testing.T) {
	db := openJobsDB(t)
	jobs, err := store.NewJobStore(db)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if _, err := jobs.Create(ctx, store.ExportJob{ID: "queued", OwnerLogin: "editor", ProjectID: "project", ProjectRevision: 1, RequestJSON: `{}`}); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"restart", "done"} {
		if _, err := jobs.Create(ctx, store.ExportJob{ID: id, OwnerLogin: "editor", ProjectID: "project", ProjectRevision: 1, RequestJSON: `{}`}); err != nil {
			t.Fatal(err)
		}
		if _, err := jobs.Start(ctx, "editor", id); err != nil {
			t.Fatal(err)
		}
	}
	if count, err := jobs.Recover(ctx); err != nil || count != 3 {
		t.Fatalf("recover = %d, %v", count, err)
	}
	queued, err := jobs.Get(ctx, "editor", "queued")
	if err != nil || queued.State != store.JobFailed {
		t.Fatalf("recovered queued job = %#v, %v", queued, err)
	}
	job, err := jobs.Get(ctx, "editor", "restart")
	if err != nil || job.State != store.JobFailed || job.ErrorCode.String != "interrupted_by_restart" {
		t.Fatalf("recovered job = %#v, %v", job, err)
	}
	if _, err := jobs.Start(ctx, "editor", "restart"); !errors.Is(err, store.ErrJobState) {
		t.Fatalf("terminal job restarted: %v", err)
	}
	if _, err := jobs.Create(ctx, store.ExportJob{ID: "completed", OwnerLogin: "editor", ProjectID: "project", ProjectRevision: 1, RequestJSON: `{}`}); err != nil {
		t.Fatal(err)
	}
	if _, err := jobs.Start(ctx, "editor", "completed"); err != nil {
		t.Fatal(err)
	}
	completed, err := jobs.Succeed(ctx, "editor", "completed", `{"outputName":"export.mkv","retainUntil":"2026-01-01T00:00:00Z"}`)
	if err != nil || completed.State != store.JobSucceeded || !completed.ResultJSON.Valid {
		t.Fatalf("completed job = %#v, %v", completed, err)
	}
}

func TestJobOwnerIsNotRevealed(t *testing.T) {
	db := openJobsDB(t)
	jobs, _ := store.NewJobStore(db)
	ctx := context.Background()
	if _, err := jobs.Create(ctx, store.ExportJob{ID: "private", OwnerLogin: "a", ProjectID: "p", ProjectRevision: 1, RequestJSON: `{}`}); err != nil {
		t.Fatal(err)
	}
	if _, err := jobs.Get(ctx, "b", "private"); !errors.Is(err, store.ErrJobNotFound) {
		t.Fatalf("cross-owner get = %v", err)
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
	if _, err := db.ExecContext(ctx, `INSERT INTO projects (id, owner_login, revision, document_json, created_at, updated_at) VALUES ('project', 'editor', 1, '{}', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`); err != nil {
		t.Fatal(err)
	}
	return db
}
