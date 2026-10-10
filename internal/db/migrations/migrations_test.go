package migrations

import (
	"database/sql"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"

	_ "modernc.org/sqlite"
)

func TestFreshSchemaAndReapply(t *testing.T) {
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "schema.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	db.SetMaxOpenConns(1)
	for range 2 {
		if err := Apply(t.Context(), db); err != nil {
			t.Fatal(err)
		}
	}
	var version int
	if err := db.QueryRowContext(t.Context(), `SELECT MAX(version_id) FROM goose_db_version WHERE is_applied`).Scan(&version); err != nil || version != 1 {
		t.Fatalf("Goose version = %d, %v", version, err)
	}
	var revision int
	if _, err := db.ExecContext(t.Context(), `INSERT INTO jobs (id,batch_id,kind,state,request_json,created_at,updated_at) VALUES ('j_test','b_test','library_scan','queued','{}','now','now')`); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRowContext(t.Context(), `SELECT revision FROM jobs WHERE id = 'j_test'`).Scan(&revision); err != nil || revision != 1 {
		t.Fatalf("revision = %d, %v", revision, err)
	}
	var legacy int
	if err := db.QueryRowContext(t.Context(), `SELECT COUNT(*) FROM sqlite_master WHERE name IN ('export_jobs','detection_jobs')`).Scan(&legacy); err != nil || legacy != 0 {
		t.Fatalf("legacy tables = %d, %v", legacy, err)
	}
}

func TestFailedBaselineRollsBackApplicationTablesAndVersion(t *testing.T) {
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "failed.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	db.SetMaxOpenConns(1)
	files := fstest.MapFS{"00001_partial.sql": {Data: []byte(`-- +goose Up
CREATE TABLE partial_application_table (id TEXT PRIMARY KEY);
THIS IS NOT VALID SQL;
-- +goose Down
DROP TABLE partial_application_table;
`)}}
	if err := apply(t.Context(), db, files); err == nil {
		t.Fatal("invalid migration unexpectedly succeeded")
	}
	var tables int
	if err := db.QueryRowContext(t.Context(), `SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='partial_application_table'`).Scan(&tables); err != nil {
		t.Fatal(err)
	}
	if tables != 0 {
		t.Fatalf("failed migration left %d application tables", tables)
	}
	var applied int
	if err := db.QueryRowContext(t.Context(), `SELECT COUNT(*) FROM goose_db_version WHERE version_id = 1 AND is_applied`).Scan(&applied); err != nil {
		t.Fatal(err)
	}
	if applied != 0 {
		t.Fatalf("failed migration was marked applied %d times", applied)
	}
}

func TestLegacyDatabaseRequiresExplicitReset(t *testing.T) {
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "legacy.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if _, err := db.ExecContext(t.Context(), `CREATE TABLE projects (id TEXT); INSERT INTO projects VALUES ('keep-until-reset')`); err != nil {
		t.Fatal(err)
	}
	if err := Apply(t.Context(), db); err == nil || !strings.Contains(err.Error(), "pre-Goose") {
		t.Fatalf("legacy database error = %v", err)
	}
	var id string
	if err := db.QueryRowContext(t.Context(), `SELECT id FROM projects`).Scan(&id); err != nil || id != "keep-until-reset" {
		t.Fatalf("unsupported database was modified: %q, %v", id, err)
	}
}
