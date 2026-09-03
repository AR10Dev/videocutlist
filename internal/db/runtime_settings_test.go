package store_test

import (
	"context"
	"errors"
	"testing"

	"videocutlist/internal/db"
)

func validRuntimeSettings() store.RuntimeSettings {
	return store.RuntimeSettings{
		MediaRoots:   map[string]string{"camera": "/media/camera"},
		Destinations: []store.RuntimeDestination{{ID: "download", Label: "Downloads", Kind: "download", Root: "/exports", Retention: "24h"}},
		ExportLimit:  1, CacheMaxBytes: 1024, PreviewGlobalLimit: 2,
		PreviewBeforeMS: 2000, PreviewAfterMS: 6000, PreviewMaxMS: 15000, PreviewGridMS: 500,
		MediaMaxFiles: 100, MediaMaxDepth: 5,
	}
}

func TestRuntimeSettingsSeedPersistsAndDoesNotOverwrite(t *testing.T) {
	ctx := context.Background()
	path := t.TempDir() + "/settings.db"
	db, err := store.OpenDatabase(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	settings, err := store.NewRuntimeSettingsStore(db)
	if err != nil {
		t.Fatal(err)
	}
	first, err := settings.Seed(ctx, validRuntimeSettings())
	if err != nil {
		t.Fatal(err)
	}
	changed := validRuntimeSettings()
	changed.ExportLimit = 9
	updated, err := settings.Update(ctx, first.Revision, changed)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := settings.Seed(ctx, validRuntimeSettings()); err != nil {
		t.Fatal(err)
	}
	if got, err := settings.Get(ctx); err != nil || got.Settings.ExportLimit != 9 || got.Revision != updated.Revision {
		t.Fatalf("persisted settings = %#v, err=%v", got, err)
	}
	db.Close()
	db, err = store.OpenDatabase(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	settings, _ = store.NewRuntimeSettingsStore(db)
	got, err := settings.Get(ctx)
	if err != nil || got.Settings.ExportLimit != 9 {
		t.Fatalf("restart settings = %#v, err=%v", got, err)
	}
}

func TestRuntimeSettingsRejectsInvalidAndStaleUpdatesAtomically(t *testing.T) {
	ctx := context.Background()
	db, err := store.OpenDatabase(ctx, t.TempDir()+"/settings.db")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	settings, _ := store.NewRuntimeSettingsStore(db)
	initial, err := settings.Seed(ctx, validRuntimeSettings())
	if err != nil {
		t.Fatal(err)
	}
	invalid := validRuntimeSettings()
	invalid.PreviewMaxMS = 1
	if _, err := settings.Update(ctx, initial.Revision, invalid); err == nil {
		t.Fatal("invalid settings accepted")
	}
	got, _ := settings.Get(ctx)
	if got.Revision != initial.Revision {
		t.Fatalf("invalid update changed revision: %d", got.Revision)
	}
	if _, err := settings.Update(ctx, initial.Revision-1, validRuntimeSettings()); !errors.Is(err, store.ErrRuntimeSettingsRevisionConflict) {
		t.Fatalf("stale update err=%v", err)
	}
}

func TestRuntimeSettingsInvalidStoredDataFails(t *testing.T) {
	ctx := context.Background()
	db, err := store.OpenDatabase(ctx, t.TempDir()+"/settings.db")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.ExecContext(ctx, `INSERT INTO runtime_settings (id, schema_version, revision, document_json, updated_at) VALUES (1, 1, 1, '{"mediaRoots":{}}', '2025-01-01T00:00:00Z')`); err != nil {
		t.Fatal(err)
	}
	settings, _ := store.NewRuntimeSettingsStore(db)
	if _, err := settings.Get(ctx); err == nil {
		t.Fatal("invalid stored data accepted")
	}
}
