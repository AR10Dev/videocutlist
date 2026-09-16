package runtime

import (
	"context"
	"errors"
	"slices"

	store "videocutlist/internal/db"
	"videocutlist/internal/jobs"
	"videocutlist/internal/library/media/index"
	"videocutlist/internal/preview/cache"
	"videocutlist/internal/projects"
	"videocutlist/internal/web/assets"
)

// RuntimeSettingsApplier updates the actual consumers; State remains the last
// persisted snapshot until the settings service publishes a successful update.
type RuntimeSettingsApplier struct {
	State         *store.RuntimeSettingsState
	Scanner       *index.Scanner
	PreviewLimits *projects.PreviewLimits
	PreviewCache  *cache.Store
	Assets        *assets.Service
	Scheduler     *jobs.Scheduler
}

func (a RuntimeSettingsApplier) Apply(ctx context.Context, settings store.RuntimeSettings) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := store.ValidateRuntimeSettings(settings); err != nil {
		return err
	}
	return applyRuntimeSettingsTransactional(settings, a.State.Snapshot(),
		func(value store.RuntimeSettings) error {
			return a.Scanner.ReconfigureLimits(index.ScanLimits{MaxFiles: value.MediaMaxFiles, MaxDepth: value.MediaMaxDepth})
		},
		func(value store.RuntimeSettings) error { return a.PreviewLimits.SetLimits(value.PreviewGlobalLimit) },
		func(value store.RuntimeSettings) error { return a.PreviewCache.SetMaxBytes(value.CacheMaxBytes) },
		func(value store.RuntimeSettings) error { return a.Assets.SetMaxBytes(value.CacheMaxBytes) },
		func(value store.RuntimeSettings) error {
			return a.Scheduler.SetLimits(jobs.SchedulerConfig{QueueCapacity: value.ExportLimit * 4, WorkerLimit: value.ExportLimit})
		},
	)
}

func applyRuntimeSettingsTransactional(settings, previous store.RuntimeSettings, steps ...func(store.RuntimeSettings) error) error {
	for _, apply := range steps {
		if err := apply(settings); err != nil {
			for _, restore := range slices.Backward(steps) {
				err = errors.Join(err, restore(previous))
			}
			return err
		}
	}
	return nil
}
