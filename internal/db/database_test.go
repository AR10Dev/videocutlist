package store_test

import (
	"context"
	"database/sql"
	"encoding/json"
	"path/filepath"
	"testing"

	"videocutlist/internal/db"
	"videocutlist/internal/library/media/index"
	"videocutlist/internal/projects/model"

	_ "modernc.org/sqlite"
)

func TestMediaSyncRollbackPreservesPreviousCatalog(t *testing.T) {
	db, err := store.OpenDatabase(context.Background(), t.TempDir()+"/media.db")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	media, err := store.NewMediaStore(db)
	if err != nil {
		t.Fatal(err)
	}
	original := index.Record{Media: index.Media{ID: "m_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", Name: "old.mp4", SizeBytes: 1, MtimeNS: 1}, RootAlias: "library", RelativePath: "old.mp4"}
	if err := media.Sync(context.Background(), "library", []index.Record{original}); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`CREATE TRIGGER fail_media_sync BEFORE INSERT ON media WHEN NEW.relative_path = 'bad.mp4' BEGIN SELECT RAISE(ABORT, 'injected sync failure'); END`); err != nil {
		t.Fatal(err)
	}
	bad := index.Record{Media: index.Media{ID: "m_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", Name: "bad.mp4", SizeBytes: 1, MtimeNS: 1}, RootAlias: "library", RelativePath: "bad.mp4"}
	if err := media.Sync(context.Background(), "library", []index.Record{bad}); err == nil {
		t.Fatal("sync unexpectedly succeeded")
	}
	got, err := media.Get(context.Background(), original.ID)
	if err != nil || got.ID != original.ID {
		t.Fatalf("original catalog lost: %#v, %v", got, err)
	}
}

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
	for _, table := range []string{"media", "projects", "export_jobs", "detection_jobs", "jobs", "cache_entries", "runtime_settings"} {
		var name string
		if err := db.QueryRow(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, table).Scan(&name); err != nil {
			t.Fatalf("missing %s: %v", table, err)
		}
		assertNoOwnerColumn(t, db, table)
	}
}

func TestOpenDatabaseMigratesLegacyProjectBeforeUnifiedJobs(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "legacy-project.db")
	legacy, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := legacy.Exec(`
		CREATE TABLE projects (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, document_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
		CREATE TABLE export_jobs (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, project_revision INTEGER NOT NULL, state TEXT NOT NULL, request_json TEXT NOT NULL, result_json TEXT, error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
		INSERT INTO projects VALUES ('p_legacy000001', 2, '{"mediaId":"m_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","segments":[{"startMs":100,"endMs":200}],"uiState":{"playheadMs":150,"zoom":2,"muted":true}}', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
		INSERT INTO export_jobs VALUES ('legacy-export', 'p_legacy000001', 2, 'queued', '{}', NULL, NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
	`); err != nil {
		t.Fatal(err)
	}
	if err := legacy.Close(); err != nil {
		t.Fatal(err)
	}
	db, err := store.OpenDatabase(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var raw string
	if err := db.QueryRowContext(ctx, `SELECT document_json FROM projects WHERE id = 'p_legacy000001'`).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	var document model.Document
	if err := json.Unmarshal([]byte(raw), &document); err != nil {
		t.Fatal(err)
	}
	if document.SchemaVersion != 2 || len(document.Items) != 1 || document.Items[0].MediaID != "m_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" || len(document.Items[0].Segments) != 1 {
		t.Fatalf("migrated document = %+v", document)
	}
	var jobs, itemMatches int
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*), SUM(project_item_id = ?) FROM jobs`, document.Items[0].ID).Scan(&jobs, &itemMatches); err != nil {
		t.Fatal(err)
	}
	if jobs != 1 || itemMatches != 1 {
		t.Fatalf("migrated jobs=%d item matches=%d", jobs, itemMatches)
	}
}

func TestOpenDatabaseMigratesLegacyIdentityColumns(t *testing.T) {
	path := filepath.Join(t.TempDir(), "legacy.db")
	legacy, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	for _, statement := range []string{
		`CREATE TABLE media (id TEXT PRIMARY KEY, root_alias TEXT NOT NULL, relative_path TEXT NOT NULL, size_bytes INTEGER NOT NULL, mtime_ns INTEGER NOT NULL, metadata_json TEXT NOT NULL, available INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (root_alias, relative_path))`,
		`CREATE TABLE projects (id TEXT PRIMARY KEY, owner_login TEXT NOT NULL, revision INTEGER NOT NULL CHECK (revision > 0), document_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
		`CREATE INDEX projects_owner_updated ON projects (owner_login, updated_at DESC)`,
		`CREATE TABLE export_jobs (id TEXT PRIMARY KEY, owner_login TEXT NOT NULL, project_id TEXT NOT NULL, project_revision INTEGER NOT NULL CHECK (project_revision > 0), state TEXT NOT NULL, request_json TEXT NOT NULL, result_json TEXT, error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
		`CREATE INDEX export_jobs_owner_updated ON export_jobs (owner_login, updated_at DESC)`,
		`CREATE TABLE detection_jobs (id TEXT PRIMARY KEY, owner_login TEXT NOT NULL, project_id TEXT NOT NULL, media_id TEXT NOT NULL, project_revision INTEGER NOT NULL CHECK (project_revision > 0), kind TEXT NOT NULL, state TEXT NOT NULL, result_json TEXT, error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
		`CREATE INDEX detection_jobs_owner_updated ON detection_jobs (owner_login, updated_at DESC)`,
	} {
		if _, err := legacy.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	const mediaID = "m_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	if _, err := legacy.Exec(`INSERT INTO media VALUES (?, 'library', 'clip.mp4', 1, 1, '{}', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`, mediaID); err != nil {
		t.Fatal(err)
	}
	document := `{"schemaVersion":2,"name":"Project","items":[{"id":"i_legacy","mediaId":"` + mediaID + `","segments":[]}]}`
	if _, err := legacy.Exec(`INSERT INTO projects VALUES ('p_legacy', 'old-user', 1, ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`, document); err != nil {
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
	for _, table := range []string{"media", "projects", "export_jobs", "detection_jobs"} {
		assertNoOwnerColumn(t, db, table)
	}
	var gotMedia, gotDocument string
	if err := db.QueryRow(`SELECT media.id, projects.document_json FROM media CROSS JOIN projects`).Scan(&gotMedia, &gotDocument); err != nil {
		t.Fatal(err)
	}
	if gotMedia != mediaID || gotDocument != document {
		t.Fatalf("migration lost data: media=%q document=%q", gotMedia, gotDocument)
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
