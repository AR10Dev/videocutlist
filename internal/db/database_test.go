package store_test

import (
	"context"
	"database/sql"
	"path/filepath"
	"slices"
	"testing"

	"videocutlist/internal/db"
	"videocutlist/internal/library/media/index"

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
	path := t.TempDir() + "/videocutlist.db"
	db, err := store.OpenDatabase(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	db, err = store.OpenDatabase(t.Context(), path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Error(err)
		}
	})
	for _, table := range []string{"media", "media_folders", "projects", "jobs", "command_admissions", "cache_entries", "runtime_settings", "mcp_credentials", "mcp_audit_entries", "export_proposals", "goose_db_version"} {
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
