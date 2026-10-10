package config

import (
	"context"
	"errors"
	"testing"

	store "videocutlist/internal/db"
	settingsmodel "videocutlist/internal/settings/model"
)

func TestRuntimeServiceRestoresAfterRequestCancellation(t *testing.T) {
	cfg, err := load(env(baseEnv()))
	if err != nil {
		t.Fatal(err)
	}
	db, err := store.OpenDatabase(t.Context(), t.TempDir()+"/settings.db")
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := db.Close(); err != nil {
			t.Error(err)
		}
	}()
	repository, _ := store.NewRuntimeSettingsStore(db)
	previous, err := repository.Seed(t.Context(), cfg.RuntimeSettings())
	if err != nil {
		t.Fatal(err)
	}
	state := settingsmodel.NewRuntimeSettingsState(previous.Settings)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	calls := 0
	service := NewRuntimeService(repository, state, func(ctx context.Context, value settingsmodel.RuntimeSettings) error {
		calls++
		if calls == 1 {
			cancel()
		} else if ctx.Err() != nil || value.ExportLimit != previous.Settings.ExportLimit {
			t.Fatal("rollback inherited the cancelled request or wrong settings")
		}
		return nil
	})
	candidate := previous.Settings
	candidate.ExportLimit = 2
	if _, err := service.Update(ctx, previous.Revision, candidate, DeploymentDocument{}); !errors.Is(err, context.Canceled) {
		t.Fatalf("update = %v", err)
	}
	record, err := repository.Get(t.Context())
	if err != nil || record.Revision != previous.Revision || calls != 2 || state.Snapshot().ExportLimit != previous.Settings.ExportLimit {
		t.Fatalf("rollback = %#v, calls=%d, err=%v", record, calls, err)
	}
}

func TestBootstrapRuntimeSettingsRefreshesOnlyDeploymentOwnedFields(t *testing.T) {
	cfg, err := load(env(baseEnv()))
	if err != nil {
		t.Fatal(err)
	}
	database, err := store.OpenDatabase(t.Context(), t.TempDir()+"/settings.db")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := database.Close(); err != nil {
			t.Error(err)
		}
	})
	repository, err := store.NewRuntimeSettingsStore(database)
	if err != nil {
		t.Fatal(err)
	}
	initial := cfg.RuntimeSettings()
	first, err := BootstrapRuntimeSettings(t.Context(), repository, initial)
	if err != nil {
		t.Fatal(err)
	}
	mutable := first.Settings
	mutable.ExportLimit = 9
	updated, err := repository.Update(t.Context(), first.Revision, mutable)
	if err != nil {
		t.Fatal(err)
	}

	deployment := cfg.RuntimeSettings()
	deployment.MediaRoots = map[string]string{"camera": "/media/current"}
	deployment.Destinations = []settingsmodel.RuntimeDestination{{ID: "download", Label: "Downloads", Kind: "download", Root: "/exports/current", Retention: "24h"}}
	refreshed, err := BootstrapRuntimeSettings(t.Context(), repository, deployment)
	if err != nil {
		t.Fatal(err)
	}
	if refreshed.Revision != updated.Revision+1 || refreshed.Settings.MediaRoots["camera"] != "/media/current" || refreshed.Settings.Destinations[0].Root != "/exports/current" {
		t.Fatalf("deployment refresh = %#v", refreshed)
	}
	if refreshed.Settings.ExportLimit != mutable.ExportLimit {
		t.Fatalf("deployment refresh overwrote mutable export limit: %d", refreshed.Settings.ExportLimit)
	}
	again, err := BootstrapRuntimeSettings(t.Context(), repository, deployment)
	if err != nil || again.Revision != refreshed.Revision {
		t.Fatalf("unchanged deployment refresh = %#v, %v", again, err)
	}
}
