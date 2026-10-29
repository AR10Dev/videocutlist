package httpapi

import (
	"errors"
	"fmt"

	"videocutlist/internal/httpapi/transport"
	settingsmodel "videocutlist/internal/settings/model"
)

var errSettingsIntegerRange = errors.New("settings value exceeds transport integer range")

func settingsResponseToTransport(record settingsmodel.RuntimeSettingsRecord, pathsConstrained bool, statuses map[string]transport.SettingsRootStatus) (transport.SettingsResponse, error) {
	revision, ok := projectRevisionToTransport(record.Revision)
	if !ok {
		return transport.SettingsResponse{}, fmt.Errorf("settings revision exceeds transport integer range")
	}
	settings, err := runtimeSettingsToTransport(record.Settings)
	if err != nil {
		return transport.SettingsResponse{}, err
	}
	roots := make(map[string]transport.SettingsRootStatus, len(statuses))
	for alias, status := range statuses {
		roots[alias] = status
	}
	return transport.SettingsResponse{
		PathsConstrained: pathsConstrained, Revision: revision, Roots: roots,
		SchemaVersion: record.SchemaVersion, Settings: settings, UpdatedAt: record.UpdatedAt,
	}, nil
}

func settingsUpdatedToTransport(record settingsmodel.RuntimeSettingsRecord) (transport.SettingsUpdated, error) {
	revision, ok := projectRevisionToTransport(record.Revision)
	if !ok {
		return transport.SettingsUpdated{}, fmt.Errorf("settings revision exceeds transport integer range")
	}
	settings, err := runtimeSettingsToTransport(record.Settings)
	if err != nil {
		return transport.SettingsUpdated{}, err
	}
	return transport.SettingsUpdated{
		Revision: revision, SchemaVersion: record.SchemaVersion,
		Settings: settings, UpdatedAt: record.UpdatedAt,
	}, nil
}

func runtimeSettingsToTransport(settings settingsmodel.RuntimeSettings) (transport.RuntimeSettings, error) {
	cacheMaxBytes := int(settings.CacheMaxBytes)
	if int64(cacheMaxBytes) != settings.CacheMaxBytes {
		return transport.RuntimeSettings{}, errSettingsIntegerRange
	}
	destinations := make([]transport.RuntimeDestination, len(settings.Destinations))
	for index, destination := range settings.Destinations {
		mapped := transport.RuntimeDestination{
			Id: destination.ID, Label: destination.Label,
			Kind: transport.RuntimeDestinationKind(destination.Kind),
		}
		if destination.Description != "" {
			mapped.Description = new(destination.Description)
		}
		if destination.Retention != "" {
			mapped.Retention = new(destination.Retention)
		}
		destinations[index] = mapped
	}
	mapped := transport.RuntimeSettings{
		CacheMaxBytes: cacheMaxBytes, ExportLimit: settings.ExportLimit,
		McpEnabled: settings.MCPEnabled, MediaMaxDepth: settings.MediaMaxDepth,
		MediaMaxFiles: settings.MediaMaxFiles, PreviewAfterMs: settings.PreviewAfterMS,
		PreviewBeforeMs: settings.PreviewBeforeMS, PreviewGlobalLimit: settings.PreviewGlobalLimit,
		PreviewGridMs: settings.PreviewGridMS, PreviewMaxMs: settings.PreviewMaxMS,
	}
	mapped.Destinations = &destinations
	return mapped, nil
}
