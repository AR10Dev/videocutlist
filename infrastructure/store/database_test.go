package store_test

import (
	"context"
	"database/sql"
	"encoding/json"
	"path/filepath"
	"testing"

	"videocutlist/domain"
	"videocutlist/infrastructure/store"

	_ "modernc.org/sqlite"
)

func TestOpenDatabaseAppliesAllMigrations(t *testing.T) {
	db, err := store.OpenDatabase(context.Background(), t.TempDir()+"/videocutlist.db")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if reopened, err := store.OpenDatabase(context.Background(), t.TempDir()+"/videocutlist.db"); err != nil {
		t.Fatal(err)
	} else {
		reopened.Close()
	}
	for _, table := range []string{"media", "projects", "export_jobs", "detection_jobs", "cache_entries", "runtime_settings"} {
		var name string
		if err := db.QueryRow(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, table).Scan(&name); err != nil {
			t.Fatalf("missing %s: %v", table, err)
		}
		assertNoOwnerColumn(t, db, table)
	}
}

func TestOpenDatabaseMigratesLegacyProjectToBatchDocument(t *testing.T) {
	path := filepath.Join(t.TempDir(), "legacy.db")
	legacy, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	for _, statement := range []string{
		`CREATE TABLE media (id TEXT PRIMARY KEY, root_alias TEXT NOT NULL, relative_path TEXT NOT NULL, size_bytes INTEGER NOT NULL, mtime_ns INTEGER NOT NULL, metadata_json TEXT NOT NULL, available INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (root_alias, relative_path))`,
		`CREATE TABLE projects (id TEXT PRIMARY KEY, owner_login TEXT NOT NULL, revision INTEGER NOT NULL, document_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
		`CREATE TABLE export_jobs (id TEXT PRIMARY KEY, owner_login TEXT NOT NULL, project_id TEXT NOT NULL, project_revision INTEGER NOT NULL, state TEXT NOT NULL, request_json TEXT NOT NULL, result_json TEXT, error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
		`CREATE TABLE detection_jobs (id TEXT PRIMARY KEY, owner_login TEXT NOT NULL, project_id TEXT NOT NULL, media_id TEXT NOT NULL, project_revision INTEGER NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL, result_json TEXT, error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
	} {
		if _, err := legacy.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	const mediaID = "m_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	if _, err := legacy.Exec(`INSERT INTO media VALUES (?, 'camera', 'clip.mp4', 1, 1, '{}', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`, mediaID); err != nil {
		t.Fatal(err)
	}
	legacyDocument := `{"mediaId":"m_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","revision":4,"segments":[{"startMs":1,"endMs":2}],"uiState":{"playheadMs":1,"zoom":2}}`
	if _, err := legacy.Exec(`INSERT INTO projects VALUES ('p_legacy', 'old-user', 4, ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`, legacyDocument); err != nil {
		t.Fatal(err)
	}
	if err := legacy.Close(); err != nil {
		t.Fatal(err)
	}

	db, err := store.OpenDatabase(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for _, table := range []string{"projects", "export_jobs", "detection_jobs"} {
		assertNoOwnerColumn(t, db, table)
	}
	var revision int64
	var documentJSON string
	if err := db.QueryRow(`SELECT revision, document_json FROM projects WHERE id = 'p_legacy'`).Scan(&revision, &documentJSON); err != nil {
		t.Fatal(err)
	}
	var document domain.Document
	if err := json.Unmarshal([]byte(documentJSON), &document); err != nil {
		t.Fatal(err)
	}
	if revision != 4 || document.SchemaVersion != domain.ProjectSchemaVersion || document.Name == "" || len(document.Items) != 1 {
		t.Fatalf("migrated project = revision %d, %#v", revision, document)
	}
	item := document.Items[0]
	if item.ID != domain.StableProjectItemID("p_legacy") || item.MediaID != mediaID || len(item.Segments) != 1 || item.EditorState == nil || item.EditorState.Zoom != 2 {
		t.Fatalf("migrated item = %#v", item)
	}
	var retained string
	if err := db.QueryRow(`SELECT id FROM media WHERE id = ?`, mediaID).Scan(&retained); err != nil || retained != mediaID {
		t.Fatalf("media was not retained: %q, %v", retained, err)
	}
}

func assertNoOwnerColumn(t *testing.T, db *sql.DB, table string) {
	t.Helper()
	var count int
	if err := db.QueryRow(`SELECT COUNT(*) FROM pragma_table_info(?) WHERE name IN ('owner_login', 'principal', 'role', 'capability')`, table).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("%s retains ownership columns", table)
	}
}
