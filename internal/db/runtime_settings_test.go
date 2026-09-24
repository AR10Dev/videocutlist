package store_test

import (
	"context"
	"errors"
	"math"
	"strconv"
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
	if err := db.Close(); err != nil {
		t.Error(err)
	}
	db, err = store.OpenDatabase(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Error(err)
		}
	})
	settings, _ = store.NewRuntimeSettingsStore(db)
	got, err := settings.Get(ctx)
	if err != nil || got.Settings.ExportLimit != 9 {
		t.Fatalf("restart settings = %#v, err=%v", got, err)
	}
}

func TestRuntimeSettingsSeedAddsNewDefaultDestinations(t *testing.T) {
	ctx := context.Background()
	db, err := store.OpenDatabase(ctx, t.TempDir()+"/settings.db")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Error(err)
		}
	})
	settings, _ := store.NewRuntimeSettingsStore(db)
	legacy := validRuntimeSettings()
	first, err := settings.Seed(ctx, legacy)
	if err != nil {
		t.Fatal(err)
	}
	defaults := legacy
	defaults.ExportLimit = 9
	defaults.Destinations = append(append([]store.RuntimeDestination{}, legacy.Destinations...), store.RuntimeDestination{
		ID: "server", Label: "Server", Kind: "archive", Root: "/exports",
	})
	migrated, err := settings.Seed(ctx, defaults)
	if err != nil {
		t.Fatal(err)
	}
	if migrated.Revision != first.Revision+1 || len(migrated.Settings.Destinations) != 2 || migrated.Settings.Destinations[1].ID != "server" {
		t.Fatalf("migrated settings = %#v", migrated)
	}
	if migrated.Settings.ExportLimit != legacy.ExportLimit {
		t.Fatalf("seed overwrote saved settings: export limit = %d", migrated.Settings.ExportLimit)
	}
}

func TestRuntimeSettingsRejectsInvalidAndStaleUpdatesAtomically(t *testing.T) {
	ctx := context.Background()
	db, err := store.OpenDatabase(ctx, t.TempDir()+"/settings.db")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Error(err)
		}
	})
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
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Error(err)
		}
	})
	if _, err := db.ExecContext(ctx, `INSERT INTO runtime_settings (id, schema_version, revision, document_json, updated_at) VALUES (1, 1, 1, '{"mediaRoots":{}}', '2025-01-01T00:00:00Z')`); err != nil {
		t.Fatal(err)
	}
	settings, _ := store.NewRuntimeSettingsStore(db)
	if _, err := settings.Get(ctx); err == nil {
		t.Fatal("invalid stored data accepted")
	}
}

func TestRuntimeSettingsExportLimitSafetyBoundary(t *testing.T) {
	db, err := store.OpenDatabase(t.Context(), t.TempDir()+"/settings.db")
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := db.Close(); err != nil {
			t.Error(err)
		}
	}()
	settings, _ := store.NewRuntimeSettingsStore(db)
	previous, err := settings.Seed(t.Context(), validRuntimeSettings())
	if err != nil {
		t.Fatal(err)
	}
	for _, limit := range []int{0, 1, 64, 65, math.MaxInt} {
		t.Run(strconv.Itoa(limit), func(t *testing.T) {
			candidate := validRuntimeSettings()
			candidate.ExportLimit = limit
			record, err := settings.Update(t.Context(), previous.Revision, candidate)
			valid := limit >= 1 && limit <= 64
			if (err == nil) != valid {
				t.Fatalf("update(%d) = %v", limit, err)
			}
			if valid {
				previous = record
			}
			current, err := settings.Get(t.Context())
			if err != nil || current.Revision != previous.Revision || current.Settings.ExportLimit != previous.Settings.ExportLimit {
				t.Fatalf("record changed on rejection: %v, %v", current, err)
			}
		})
	}
	if _, err := db.ExecContext(t.Context(), `UPDATE runtime_settings SET document_json = json_set(document_json, '$.exportLimit', 65)`); err != nil {
		t.Fatal(err)
	}
	if _, err := settings.Get(t.Context()); err == nil {
		t.Fatal("accepted unsafe persisted export limit")
	}
}

func TestRuntimeSettingsSeedRefreshesDeploymentOwnedPaths(t *testing.T) {
	ctx := t.Context()
	database, err := store.OpenDatabase(ctx, t.TempDir()+"/settings.db")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := database.Close(); err != nil {
			t.Error(err)
		}
	})
	settings, err := store.NewRuntimeSettingsStore(database)
	if err != nil {
		t.Fatal(err)
	}
	initial := validRuntimeSettings()
	initial.MediaRoots = map[string]string{"camera": "/media/old"}
	initial.Destinations = []store.RuntimeDestination{{ID: "download", Label: "Downloads", Kind: "download", Root: "/exports/old", Retention: "24h"}}
	first, err := settings.Seed(ctx, initial)
	if err != nil {
		t.Fatal(err)
	}
	mutable := first.Settings
	mutable.ExportLimit = 9
	updated, err := settings.Update(ctx, first.Revision, mutable)
	if err != nil {
		t.Fatal(err)
	}

	deployment := initial
	deployment.MediaRoots = map[string]string{"camera": "/media/current"}
	deployment.Destinations = []store.RuntimeDestination{{ID: "download", Label: "Downloads", Kind: "download", Root: "/exports/current", Retention: "24h"}}
	refreshed, err := settings.Seed(ctx, deployment)
	if err != nil {
		t.Fatal(err)
	}
	if refreshed.Revision != updated.Revision+1 {
		t.Fatalf("revision = %d, want %d", refreshed.Revision, updated.Revision+1)
	}
	if refreshed.Settings.MediaRoots["camera"] != "/media/current" || refreshed.Settings.Destinations[0].Root != "/exports/current" {
		t.Fatalf("deployment paths = %#v", refreshed.Settings)
	}
	if refreshed.Settings.ExportLimit != mutable.ExportLimit {
		t.Fatalf("seed overwrote mutable export limit: %d", refreshed.Settings.ExportLimit)
	}
}
