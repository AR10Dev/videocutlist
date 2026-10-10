package runtime

import (
	"context"
	"errors"
	"slices"

	"videocutlist/internal/jobs"
	"videocutlist/internal/library/media/index"
	previewpkg "videocutlist/internal/preview"
	"videocutlist/internal/preview/assets"
	"videocutlist/internal/preview/cache"
	settingsmodel "videocutlist/internal/settings/model"
)

// RuntimeSettingsApplier updates the actual consumers; State remains the last
// persisted snapshot until the settings service publishes a successful update.
type RuntimeSettingsApplier struct {
	State         *settingsmodel.RuntimeSettingsState
	Scanner       *index.Scanner
	PreviewLimits *previewpkg.PreviewLimits
	PreviewCache  *cache.Store
	Assets        *assets.Service
	Scheduler     *jobs.Scheduler
}

// CacheBudgets partitions one configured disk budget between preview clips and timeline assets.
func CacheBudgets(total int64) (preview, timeline int64) {
	timeline = total / 4
	if timeline < 1 {
		timeline = 1
	}
	preview = total - timeline
	if preview < 1 {
		preview = 1
	}
	return preview, timeline
}

func (a RuntimeSettingsApplier) Apply(ctx context.Context, settings settingsmodel.RuntimeSettings) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := settingsmodel.ValidateRuntimeSettings(settings); err != nil {
		return err
	}
	return applyRuntimeSettingsTransactional(settings, a.State.Snapshot(),
		func(value settingsmodel.RuntimeSettings) error {
			return a.Scanner.ReconfigureLimits(index.ScanLimits{MaxFiles: value.MediaMaxFiles, MaxDepth: value.MediaMaxDepth})
		},
		func(value settingsmodel.RuntimeSettings) error {
			return a.PreviewLimits.SetLimits(value.PreviewGlobalLimit)
		},
		func(value settingsmodel.RuntimeSettings) error {
			preview, _ := CacheBudgets(value.CacheMaxBytes)
			return a.PreviewCache.SetMaxBytes(preview)
		},
		func(value settingsmodel.RuntimeSettings) error {
			_, timeline := CacheBudgets(value.CacheMaxBytes)
			return a.Assets.SetMaxBytes(timeline)
		},
		func(value settingsmodel.RuntimeSettings) error {
			return a.Scheduler.SetLimits(jobs.SchedulerConfig{QueueCapacity: value.ExportLimit * 4, WorkerLimit: value.ExportLimit})
		},
	)
}

func applyRuntimeSettingsTransactional(settings, previous settingsmodel.RuntimeSettings, steps ...func(settingsmodel.RuntimeSettings) error) error {
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
