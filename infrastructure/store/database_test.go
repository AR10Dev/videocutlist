package store_test

import (
	"context"
	"database/sql"
	"testing"

	"videocutlist/infrastructure/media/index"
	"videocutlist/infrastructure/store"

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
