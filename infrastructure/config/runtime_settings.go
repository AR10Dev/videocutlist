package config

import (
	"fmt"
	"time"

	exporter "videocutlist/infrastructure/export"
	"videocutlist/infrastructure/store"
)

// RuntimeSettings returns the validated environment values that may be
// persisted and changed by the runtime settings API.
func (c Config) RuntimeSettings() store.RuntimeSettings {
	destinations := make([]store.RuntimeDestination, len(c.Destinations))
	for i, destination := range c.Destinations {
		destinations[i] = store.RuntimeDestination{ID: destination.ID, Label: destination.Label, Description: destination.Description, Kind: destination.Kind, Root: destination.Root, Retention: destination.RetentionText, MediaRoot: destination.MediaRoot}
	}
	return store.RuntimeSettings{MediaRoots: c.MediaRoots, Destinations: destinations, ExportLimit: c.ExportLimit, CacheMaxBytes: c.CacheMaxBytes, PreviewGlobalLimit: c.PreviewGlobalLimit, PreviewBeforeMS: c.PreviewBeforeMS, PreviewAfterMS: c.PreviewAfterMS, PreviewMaxMS: c.PreviewMaxMS, PreviewGridMS: c.PreviewGridMS, MediaMaxFiles: c.MediaMaxFiles, MediaMaxDepth: c.MediaMaxDepth}
}

// ApplyRuntimeSettings replaces the mutable runtime portion of Config.
func (c *Config) ApplyRuntimeSettings(settings store.RuntimeSettings) error {
	if err := store.ValidateRuntimeSettings(settings); err != nil {
		return err
	}
	destinations := make([]exporter.Destination, len(settings.Destinations))
	for i, destination := range settings.Destinations {
		retention := time.Duration(0)
		if destination.Retention != "" {
			var err error
			retention, err = time.ParseDuration(destination.Retention)
			if err != nil || retention < 0 {
				return fmt.Errorf("invalid destination retention: %w", err)
			}
		}
		destinations[i] = exporter.Destination{ID: destination.ID, Label: destination.Label, Description: destination.Description, Kind: destination.Kind, Root: destination.Root, Retention: retention, RetentionText: destination.Retention, MediaRoot: destination.MediaRoot}
	}
	c.MediaRoots, c.Destinations = settings.MediaRoots, destinations
	c.ExportLimit, c.CacheMaxBytes = settings.ExportLimit, settings.CacheMaxBytes
	c.PreviewGlobalLimit = settings.PreviewGlobalLimit
	c.PreviewBeforeMS, c.PreviewAfterMS, c.PreviewMaxMS, c.PreviewGridMS = settings.PreviewBeforeMS, settings.PreviewAfterMS, settings.PreviewMaxMS, settings.PreviewGridMS
	c.MediaMaxFiles, c.MediaMaxDepth = settings.MediaMaxFiles, settings.MediaMaxDepth
	return nil
}
