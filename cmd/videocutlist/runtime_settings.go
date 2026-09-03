package main

import (
	"errors"

	"videocutlist/internal/db"
)

// applyRuntimeSettingsTransactional applies each mutable runtime subsystem and
// restores every subsystem when a later step fails. Persistence is performed by
// the caller only after this function succeeds.
func applyRuntimeSettingsTransactional(
	settings, previous store.RuntimeSettings,
	applyConfig func(store.RuntimeSettings) error,
	applyRoots func(store.RuntimeSettings) error,
	applyScanLimits func(store.RuntimeSettings) error,
	applyPreviewLimits func(store.RuntimeSettings) error,
	applyCacheLimit func(store.RuntimeSettings) error,
) error {
	if err := applyConfig(settings); err != nil {
		return err
	}
	rollback := func(cause error) error {
		var rollbackErr error
		for _, restore := range []func(store.RuntimeSettings) error{
			applyCacheLimit,
			applyPreviewLimits,
			applyScanLimits,
			applyRoots,
			applyConfig,
		} {
			if err := restore(previous); err != nil {
				rollbackErr = errors.Join(rollbackErr, err)
			}
		}
		return errors.Join(cause, rollbackErr)
	}
	if err := applyRoots(settings); err != nil {
		return rollback(err)
	}
	if err := applyScanLimits(settings); err != nil {
		return rollback(err)
	}
	if err := applyPreviewLimits(settings); err != nil {
		return rollback(err)
	}
	if err := applyCacheLimit(settings); err != nil {
		return rollback(err)
	}
	return nil
}
