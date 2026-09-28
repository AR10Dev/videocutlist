package config

import (
	"context"
	"errors"
	"testing"

	store "videocutlist/internal/db"
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
	state := store.NewRuntimeSettingsState(previous.Settings)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	calls := 0
	service := NewRuntimeService(repository, state, func(ctx context.Context, value store.RuntimeSettings) error {
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
