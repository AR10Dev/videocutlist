package store_test

import (
	"context"
	"testing"

	"editapp/internal/store"
)

func TestOpenDatabaseAppliesAllMigrations(t *testing.T) {
	db, err := store.OpenDatabase(context.Background(), t.TempDir()+"/editapp.db")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for _, table := range []string{"media", "projects", "export_jobs", "cache_entries"} {
		var name string
		if err := db.QueryRow(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, table).Scan(&name); err != nil {
			t.Fatalf("missing %s: %v", table, err)
		}
	}
}
