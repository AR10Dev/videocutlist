package store_test

import (
	"context"
	"errors"
	"path/filepath"
	"testing"

	"videocutlist/internal/db"
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

func TestProjectStoreListReturnsOpaqueSummariesAndCursor(t *testing.T) {
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
	for _, project := range []struct{ id, name string }{{"p_aaaaaaaaaaaa", "Alpha"}, {"p_bbbbbbbbbbbb", "Beta"}} {
		if _, err := projects.Save(ctx, project.id, 0, `{"name":"`+project.name+`"}`); err != nil {
			t.Fatal(err)
		}
	}
	items, next, err := projects.List(ctx, "", 1)
	if err != nil || len(items) != 1 || next == nil || items[0].Name != "Alpha" || items[0].Revision != 1 {
		t.Fatalf("list = %#v, %v, %v", items, next, err)
	}
}
