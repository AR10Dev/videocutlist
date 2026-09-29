package store_test

import (
	"context"
	"database/sql"
	"encoding/json"
	"path/filepath"
	"slices"
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
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Error(err)
		}
	})
	media, err := store.NewMediaStore(db)
	if err != nil {
		t.Fatal(err)
	}
	original := index.Record{Media: index.Media{ID: "m_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", Name: "old.mp4", SizeBytes: 1, MtimeNS: 1}, RootAlias: "library", RelativePath: "nested/old.mp4"}
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
	folders, _, _, err := media.Browse(t.Context(), "", "", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(folders) != 1 || folders[0].ID != index.FolderID("library", "nested") {
		t.Fatalf("failed sync changed available folders: %#v", folders)
	}
}

func TestReconcileRootsHidesOnlyRemovedAliases(t *testing.T) {
	database, err := store.OpenDatabase(t.Context(), t.TempDir()+"/media.db")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	media, err := store.NewMediaStore(database)
	if err != nil {
		t.Fatal(err)
	}
	for _, alias := range []string{"retained", "removed"} {
		record := index.Record{Media: index.Media{ID: index.MediaID(alias, "clip.mp4"), Name: "clip.mp4", SizeBytes: 1, MtimeNS: 1}, RootAlias: alias, RelativePath: "clip.mp4"}
		if err := media.Sync(t.Context(), alias, []index.Record{record}); err != nil {
			t.Fatal(err)
		}
	}
	if err := media.ReconcileRoots(t.Context(), map[string]string{"retained": "/media/retained"}); err != nil {
		t.Fatal(err)
	}
	if _, err := media.Get(t.Context(), index.MediaID("retained", "clip.mp4")); err != nil {
		t.Fatalf("retained root media disappeared: %v", err)
	}
	if _, err := media.Get(t.Context(), index.MediaID("removed", "clip.mp4")); err == nil {
		t.Fatal("removed root media is still available")
	}
}

func TestOpenDatabaseAppliesAllMigrations(t *testing.T) {
	db, err := store.OpenDatabase(context.Background(), t.TempDir()+"/videocutlist.db")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Error(err)
		}
	})
	if reopened, err := store.OpenDatabase(context.Background(), t.TempDir()+"/videocutlist.db"); err != nil {
		t.Fatal(err)
	} else if err := reopened.Close(); err != nil {
		t.Error(err)
	}
	for _, table := range []string{"media", "media_folders", "projects", "export_jobs", "detection_jobs", "jobs", "cache_entries", "runtime_settings", "mcp_credentials", "mcp_audit_entries"} {
		var name string
		if err := db.QueryRow(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, table).Scan(&name); err != nil {
			t.Fatalf("missing %s: %v", table, err)
		}
		assertNoOwnerColumn(t, db, table)
	}
}

func TestOpenDatabaseDoesNotRebuildExportProposalsOnRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "proposals.db")
	database, err := store.OpenDatabase(t.Context(), path)
	if err != nil {
		t.Fatal(err)
	}
	const credential = "c_migration"
	if _, err := database.ExecContext(t.Context(), `INSERT INTO mcp_credentials
(id, token_identifier, token_verifier, name, permissions_json, media_scope_json, project_scope_json, created_at, updated_at)
VALUES (?, 'migration', 'verifier', 'Migration', '[]', '{}', '{}', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`, credential); err != nil {
		t.Fatal(err)
	}
	if _, err := database.ExecContext(t.Context(), `INSERT INTO export_proposals
(id, credential_id, project_id, project_revision, payload_json, findings_json, requires_reencoding, accuracy, destination_id, expires_at, created_at)
VALUES ('ep_first', ?, NULL, 0, '{}', '[]', 0, 'frame_exact', 'download', '2027-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`, credential); err != nil {
		t.Fatal(err)
	}
	// A consumer's SQLite trigger must survive restarting the application.
	if _, err := database.ExecContext(t.Context(), `CREATE TABLE proposal_events (id TEXT NOT NULL);
CREATE TRIGGER proposal_insert AFTER INSERT ON export_proposals
BEGIN INSERT INTO proposal_events (id) VALUES (NEW.id); END;`); err != nil {
		t.Fatal(err)
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}
	database, err = store.OpenDatabase(t.Context(), path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if _, err := database.ExecContext(t.Context(), `INSERT INTO export_proposals
(id, credential_id, project_id, project_revision, payload_json, findings_json, requires_reencoding, accuracy, destination_id, expires_at, created_at)
VALUES ('ep_second', ?, NULL, 0, '{}', '[]', 0, 'frame_exact', 'download', '2027-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`, credential); err != nil {
		t.Fatal(err)
	}
	var original, observed int
	if err := database.QueryRowContext(t.Context(), `SELECT COUNT(*) FROM export_proposals WHERE id = 'ep_first'`).Scan(&original); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRowContext(t.Context(), `SELECT COUNT(*) FROM proposal_events WHERE id = 'ep_second'`).Scan(&observed); err != nil {
		t.Fatal(err)
	}
	if original != 1 || observed != 1 {
		t.Fatalf("restart lost persisted proposal or its insert trigger: original=%d observed=%d", original, observed)
	}
}

func TestExportProposalMigrationRollbackCanBeRetried(t *testing.T) {
	path := filepath.Join(t.TempDir(), "retry.db")
	database, err := store.OpenDatabase(t.Context(), path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.ExecContext(t.Context(), `INSERT INTO mcp_credentials
(id, token_identifier, token_verifier, name, permissions_json, media_scope_json, project_scope_json, created_at, updated_at)
VALUES ('c_retry', 'retry', 'verifier', 'Retry', '[]', '{}', '{}', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
INSERT INTO export_proposals
(id, credential_id, project_id, project_revision, payload_json, findings_json, requires_reencoding, accuracy, destination_id, expires_at, created_at)
VALUES ('ep_retry', 'c_retry', NULL, 0, '{}', '[]', 0, 'frame_exact', 'download', '2027-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
-- Recreate the pre-010 media schema alongside the unversioned proposal fixture.
DROP INDEX media_available_parent_id;
DROP TABLE media_folders;
ALTER TABLE media DROP COLUMN parent_folder_id;
PRAGMA user_version = 0;
CREATE TABLE export_proposals_v2 AS SELECT * FROM export_proposals WHERE 0;
CREATE TRIGGER fail_proposal_copy BEFORE INSERT ON export_proposals_v2
BEGIN SELECT RAISE(ABORT, 'injected migration failure'); END;`); err != nil {
		t.Fatal(err)
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}
	if failed, err := store.OpenDatabase(t.Context(), path); err == nil {
		_ = failed.Close()
		t.Fatal("migration unexpectedly succeeded through the injected copy failure")
	}
	inspect, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	var originals, version int
	if err := inspect.QueryRowContext(t.Context(), `SELECT COUNT(*) FROM export_proposals WHERE id = 'ep_retry'`).Scan(&originals); err != nil {
		t.Fatal(err)
	}
	if err := inspect.QueryRowContext(t.Context(), `PRAGMA user_version`).Scan(&version); err != nil {
		t.Fatal(err)
	}
	if originals != 1 || version != 0 {
		t.Fatalf("failed migration changed live proposal or version: proposals=%d version=%d", originals, version)
	}
	if _, err := inspect.ExecContext(t.Context(), `DROP TABLE export_proposals_v2`); err != nil {
		t.Fatal(err)
	}
	if err := inspect.Close(); err != nil {
		t.Fatal(err)
	}
	recovered, err := store.OpenDatabase(t.Context(), path)
	if err != nil {
		t.Fatalf("migration retry failed: %v", err)
	}
	t.Cleanup(func() { _ = recovered.Close() })
	if err := recovered.QueryRowContext(t.Context(), `SELECT COUNT(*) FROM export_proposals WHERE id = 'ep_retry'`).Scan(&originals); err != nil {
		t.Fatal(err)
	}
	if err := recovered.QueryRowContext(t.Context(), `PRAGMA user_version`).Scan(&version); err != nil {
		t.Fatal(err)
	}
	if originals != 1 || version != 10 {
		t.Fatalf("migration retry lost proposal or marker: proposals=%d version=%d", originals, version)
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
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Error(err)
		}
	})
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
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Error(err)
		}
	})
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

// createVersion9MediaDatabase recreates the pre-folder-index schema with a
// version-9 marker, rather than seeding records through the new Sync path.
func createVersion9MediaDatabase(t *testing.T, path string) *sql.DB {
	t.Helper()
	legacy, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := legacy.ExecContext(t.Context(), `
CREATE TABLE media (
  id TEXT PRIMARY KEY,
  root_alias TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  mtime_ns INTEGER NOT NULL,
  metadata_json TEXT NOT NULL,
  available INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (root_alias, relative_path)
);
CREATE TABLE export_proposals (
  id TEXT PRIMARY KEY,
  credential_id TEXT NOT NULL,
  project_id TEXT,
  project_revision INTEGER NOT NULL CHECK (project_revision >= 0),
  payload_json TEXT NOT NULL,
  findings_json TEXT NOT NULL,
  requires_reencoding INTEGER NOT NULL CHECK (requires_reencoding IN (0, 1)),
  accuracy TEXT NOT NULL CHECK (accuracy IN ('frame_exact', 'keyframe_limited', 'mixed')),
  destination_id TEXT NOT NULL CHECK (destination_id = 'download'),
  expires_at TEXT NOT NULL,
  approved_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (credential_id) REFERENCES mcp_credentials (id),
  FOREIGN KEY (project_id) REFERENCES projects (id)
);
PRAGMA user_version = 9;
`); err != nil {
		_ = legacy.Close()
		t.Fatal(err)
	}
	for _, record := range []struct {
		alias, relative string
		available       int
	}{
		{"library", "nested/deep/first.mp4", 1},
		{"library", "nested/deep/second.mp4", 1},
		{"library", "nested/hidden/removed.mp4", 0},
		{"other", "nested/deep/third.mp4", 1},
		{"library", "top.mp4", 1},
	} {
		if _, err := legacy.ExecContext(t.Context(), `INSERT INTO media
(id, root_alias, relative_path, size_bytes, mtime_ns, metadata_json, available, created_at, updated_at)
VALUES (?, ?, ?, 7, 13, '{}', ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
			index.MediaID(record.alias, record.relative), record.alias, record.relative, record.available); err != nil {
			_ = legacy.Close()
			t.Fatal(err)
		}
	}
	return legacy
}

func TestOpenDatabaseUpgradesVersion9MediaFolders(t *testing.T) {
	path := filepath.Join(t.TempDir(), "version9.db")
	legacy := createVersion9MediaDatabase(t, path)
	if err := legacy.Close(); err != nil {
		t.Fatal(err)
	}
	database, err := store.OpenDatabase(t.Context(), path)
	if err != nil {
		t.Fatal(err)
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}
	database, err = store.OpenDatabase(t.Context(), path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	media, err := store.NewMediaStore(database)
	if err != nil {
		t.Fatal(err)
	}
	library := index.FolderID("library", "nested")
	folders, items, next, err := media.Browse(t.Context(), "", "", 10)
	if err != nil || len(items) != 1 || items[0].ID != index.MediaID("library", "top.mp4") ||
		next != "" || len(folders) != 2 || !containsFolder(folders, library) ||
		!containsFolder(folders, index.FolderID("other", "nested")) {
		t.Fatalf("upgraded root browse: folders=%#v items=%#v next=%q err=%v", folders, items, next, err)
	}
	folders, items, next, err = media.Browse(t.Context(), library, "", 10)
	if err != nil || len(folders) != 1 || folders[0].ID != index.FolderID("library", "nested/deep") ||
		folders[0].Label != "deep" || len(items) != 0 || next != "" {
		t.Fatalf("upgraded nested browse: folders=%#v items=%#v next=%q err=%v", folders, items, next, err)
	}
	deep := index.FolderID("library", "nested/deep")
	_, items, _, err = media.Browse(t.Context(), deep, "", 10)
	if err != nil || len(items) != 2 {
		t.Fatalf("upgraded deep browse: items=%#v err=%v", items, err)
	}
	for _, relative := range []string{"nested/deep/first.mp4", "nested/deep/second.mp4"} {
		id := index.MediaID("library", relative)
		record, err := media.Get(t.Context(), id)
		if err != nil || record.RelativePath != relative || record.SizeBytes != 7 {
			t.Fatalf("upgraded Get(%s): %#v, %v", id, record, err)
		}
		if !slices.ContainsFunc(items, func(item index.Media) bool { return item.ID == id && item.Name == filepath.Base(relative) }) {
			t.Fatalf("upgraded Browse missing %s: %#v", id, items)
		}
	}
	hidden := index.MediaID("library", "nested/hidden/removed.mp4")
	if _, err := media.Get(t.Context(), hidden); err == nil {
		t.Fatal("unavailable media became available")
	}
	var parent string
	var available, marker, hiddenFolders int
	if err := database.QueryRowContext(t.Context(), `SELECT parent_folder_id, available FROM media WHERE id = ?`, hidden).Scan(&parent, &available); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRowContext(t.Context(), `SELECT COUNT(*) FROM media_folders WHERE id = ?`, index.FolderID("library", "nested/hidden")).Scan(&hiddenFolders); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRowContext(t.Context(), `PRAGMA user_version`).Scan(&marker); err != nil {
		t.Fatal(err)
	}
	if parent != index.FolderID("library", "nested/hidden") || available != 0 || hiddenFolders != 0 || marker != 10 {
		t.Fatalf("unavailable media or migration marker changed: parent=%q available=%d hiddenFolders=%d version=%d", parent, available, hiddenFolders, marker)
	}
}

func TestMediaFolderMigrationRollsBackAndRetries(t *testing.T) {
	path := filepath.Join(t.TempDir(), "retry-media.db")
	legacy := createVersion9MediaDatabase(t, path)
	if _, err := legacy.ExecContext(t.Context(), `CREATE TRIGGER fail_media_parent BEFORE UPDATE OF parent_folder_id ON media
BEGIN SELECT RAISE(ABORT, 'injected media migration failure'); END;`); err != nil {
		t.Fatal(err)
	}
	if err := legacy.Close(); err != nil {
		t.Fatal(err)
	}
	if failed, err := store.OpenDatabase(t.Context(), path); err == nil {
		_ = failed.Close()
		t.Fatal("media migration unexpectedly succeeded")
	}
	inspect, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	var marker, addedColumn, folderTable, rows int
	if err := inspect.QueryRowContext(t.Context(), `PRAGMA user_version`).Scan(&marker); err != nil {
		t.Fatal(err)
	}
	if err := inspect.QueryRowContext(t.Context(), `SELECT COUNT(*) FROM pragma_table_info('media') WHERE name = 'parent_folder_id'`).Scan(&addedColumn); err != nil {
		t.Fatal(err)
	}
	if err := inspect.QueryRowContext(t.Context(), `SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'media_folders'`).Scan(&folderTable); err != nil {
		t.Fatal(err)
	}
	if err := inspect.QueryRowContext(t.Context(), `SELECT COUNT(*) FROM media`).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if marker != 9 || addedColumn != 0 || folderTable != 0 || rows != 5 {
		t.Fatalf("failed upgrade changed old media schema or rows: version=%d column=%d table=%d rows=%d", marker, addedColumn, folderTable, rows)
	}
	if _, err := inspect.ExecContext(t.Context(), `DROP TRIGGER fail_media_parent`); err != nil {
		t.Fatal(err)
	}
	if err := inspect.Close(); err != nil {
		t.Fatal(err)
	}
	recovered, err := store.OpenDatabase(t.Context(), path)
	if err != nil {
		t.Fatalf("retry media migration: %v", err)
	}
	t.Cleanup(func() { _ = recovered.Close() })
	if err := recovered.QueryRowContext(t.Context(), `PRAGMA user_version`).Scan(&marker); err != nil {
		t.Fatal(err)
	}
	if err := recovered.QueryRowContext(t.Context(), `SELECT COUNT(*) FROM media_folders WHERE available = 1`).Scan(&folderTable); err != nil {
		t.Fatal(err)
	}
	if marker != 10 || folderTable != 4 {
		t.Fatalf("retry media migration: version=%d folders=%d", marker, folderTable)
	}
}

func TestMediaBrowsePaginatesNestedFoldersAcrossRoots(t *testing.T) {
	ctx := context.Background()
	db, err := store.OpenDatabase(ctx, filepath.Join(t.TempDir(), "media.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Error(err)
		}
	})
	media, err := store.NewMediaStore(db)
	if err != nil {
		t.Fatal(err)
	}
	rootA := []index.Record{
		{Media: index.Media{ID: "m_001", SizeBytes: 1, MtimeNS: 1}, RootAlias: "root-a", RelativePath: "nested/shared/a.mp4"},
		{Media: index.Media{ID: "m_003", SizeBytes: 3, MtimeNS: 3}, RootAlias: "root-a", RelativePath: "nested/shared/c.mp4"},
		{Media: index.Media{ID: "m_005", SizeBytes: 5, MtimeNS: 5}, RootAlias: "root-a", RelativePath: "nested/other/e.mp4"},
		{Media: index.Media{ID: "m_007", SizeBytes: 7, MtimeNS: 7}, RootAlias: "root-a", RelativePath: "top-a.mp4"},
	}
	rootB := []index.Record{
		{Media: index.Media{ID: "m_002", SizeBytes: 2, MtimeNS: 2}, RootAlias: "root-b", RelativePath: "nested/shared/b.mp4"},
		{Media: index.Media{ID: "m_004", SizeBytes: 4, MtimeNS: 4}, RootAlias: "root-b", RelativePath: "top-b.mp4"},
		{Media: index.Media{ID: "m_006", SizeBytes: 6, MtimeNS: 6}, RootAlias: "root-b", RelativePath: "other/root/b.mp4"},
	}
	if err := media.Sync(ctx, "root-a", rootA); err != nil {
		t.Fatal(err)
	}
	if err := media.Sync(ctx, "root-b", rootB); err != nil {
		t.Fatal(err)
	}

	folders, items, next, err := media.Browse(ctx, "", "", 1)
	if err != nil {
		t.Fatal(err)
	}
	wantFolders := map[string]string{
		index.FolderID("root-a", "nested"): "nested",
		index.FolderID("root-b", "nested"): "nested",
		index.FolderID("root-b", "other"):  "other",
	}
	for i, folder := range folders {
		if i > 0 && folders[i-1].ID >= folder.ID {
			t.Fatalf("folders are not sorted: %#v", folders)
		}
		label, ok := wantFolders[folder.ID]
		if !ok || label != folder.Label {
			t.Fatalf("unexpected root folder: %#v", folder)
		}
		delete(wantFolders, folder.ID)
	}
	if len(wantFolders) != 0 {
		t.Fatalf("root folders missing: %#v", wantFolders)
	}
	if len(items) != 1 || items[0].ID != "m_004" || items[0].Name != "top-b.mp4" || next != "m_004" {
		t.Fatalf("first root page = items %#v, next %q", items, next)
	}

	_, items, next, err = media.Browse(ctx, "", next, 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || items[0].ID != "m_007" || items[0].Name != "top-a.mp4" || next != "" {
		t.Fatalf("second root page = items %#v, next %q", items, next)
	}
	_, items, next, err = media.Browse(ctx, "", "m_007", 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 0 || next != "" {
		t.Fatalf("root page after end = items %#v, next %q", items, next)
	}

	shared := index.FolderID("root-a", "nested/shared")
	_, items, next, err = media.Browse(ctx, shared, "", 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || items[0].ID != "m_001" || next != "m_001" {
		t.Fatalf("first nested page = items %#v, next %q", items, next)
	}
	_, items, next, err = media.Browse(ctx, shared, next, 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || items[0].ID != "m_003" || next != "" {
		t.Fatalf("second nested page = items %#v, next %q", items, next)
	}
	_, items, next, err = media.Browse(ctx, shared, "m_003", 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 0 || next != "" {
		t.Fatalf("nested page after end = items %#v, next %q", items, next)
	}

	nested := index.FolderID("root-a", "nested")
	folders, items, next, err = media.Browse(ctx, nested, "", 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 0 || next != "" || len(folders) != 2 {
		t.Fatalf("nested folder page = folders %#v, items %#v, next %q", folders, items, next)
	}
}

func TestMediaBrowseReconcilesFoldersOnSyncAndRootRemoval(t *testing.T) {
	ctx := t.Context()
	database, err := store.OpenDatabase(ctx, filepath.Join(t.TempDir(), "media.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	media, err := store.NewMediaStore(database)
	if err != nil {
		t.Fatal(err)
	}
	record := func(alias, relative string) index.Record {
		return index.Record{
			Media:        index.Media{ID: index.MediaID(alias, relative), SizeBytes: 1, MtimeNS: 1},
			RootAlias:    alias,
			RelativePath: relative,
		}
	}
	keep := record("root-a", "nested/deep/keep.mp4")
	if err := media.Sync(ctx, "root-a", []index.Record{keep, record("root-a", "old/removed.mp4")}); err != nil {
		t.Fatal(err)
	}
	if err := media.Sync(ctx, "root-b", []index.Record{record("root-b", "nested/other.mp4")}); err != nil {
		t.Fatal(err)
	}
	if err := media.Sync(ctx, "root-a", []index.Record{keep}); err != nil {
		t.Fatal(err)
	}
	folders, _, _, err := media.Browse(ctx, "", "", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(folders) != 2 || !containsFolder(folders, index.FolderID("root-a", "nested")) ||
		!containsFolder(folders, index.FolderID("root-b", "nested")) {
		t.Fatalf("rescan did not remove stale root-a folder: %#v", folders)
	}
	folders, items, _, err := media.Browse(ctx, index.FolderID("root-a", "nested"), "", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(folders) != 1 || folders[0].ID != index.FolderID("root-a", "nested/deep") || len(items) != 0 {
		t.Fatalf("nested children changed after rescan: folders %#v, items %#v", folders, items)
	}
	if err := media.Sync(ctx, "root-a", nil); err != nil {
		t.Fatal(err)
	}
	folders, _, _, err = media.Browse(ctx, "", "", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(folders) != 1 || folders[0].ID != index.FolderID("root-b", "nested") {
		t.Fatalf("empty scan hid another root or retained removed folder: %#v", folders)
	}
	if err := media.ReconcileRoots(ctx, map[string]string{}); err != nil {
		t.Fatal(err)
	}
	folders, _, _, err = media.Browse(ctx, "", "", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(folders) != 0 {
		t.Fatalf("removed root still has browsable folders: %#v", folders)
	}
	if err := media.Sync(ctx, "root-a", []index.Record{keep}); err != nil {
		t.Fatal(err)
	}
	folders, _, _, err = media.Browse(ctx, "", "", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(folders) != 1 || folders[0].ID != index.FolderID("root-a", "nested") {
		t.Fatalf("rescan did not restore opaque folder ID: %#v", folders)
	}
	_, items, _, err = media.Browse(ctx, index.FolderID("root-a", "nested/deep"), "", 10)
	if err != nil || len(items) != 1 || items[0].ID != keep.ID {
		t.Fatalf("restored folder items: %#v, %v", items, err)
	}
}

func containsFolder(folders []index.Folder, id string) bool {
	return slices.ContainsFunc(folders, func(folder index.Folder) bool { return folder.ID == id })
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
