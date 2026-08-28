package store_test

import (
	"context"
	"errors"
	"path/filepath"
	"testing"

	"videocutlist/infrastructure/store"
)

func TestProjectStoreRevisionConflictPreservesDocument(t *testing.T) {
	ctx := context.Background()
	db, err := store.OpenDatabase(ctx, filepath.Join(t.TempDir(), "projects.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	projects, err := store.NewProjectStore(db)
	if err != nil {
		t.Fatal(err)
	}
	created, err := projects.Save(ctx, "p_batch", 0, `{"name":"first"}`)
	if err != nil || created.Revision != 1 {
		t.Fatalf("create = %#v, %v", created, err)
	}
	updated, err := projects.Save(ctx, "p_batch", created.Revision, `{"name":"second"}`)
	if err != nil || updated.Revision != 2 {
		t.Fatalf("update = %#v, %v", updated, err)
	}
	if _, err := projects.Save(ctx, "p_batch", created.Revision, `{"name":"stale"}`); !errors.Is(err, store.ErrRevisionConflict) {
		t.Fatalf("stale save = %v", err)
	}
	stored, err := projects.Get(ctx, "p_batch")
	if err != nil || stored.Revision != 2 || stored.DocumentJSON != `{"name":"second"}` {
		t.Fatalf("stored = %#v, %v", stored, err)
	}
}
