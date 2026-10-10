// Package model owns the dependency-light runtime settings contract and policy.
package model

import (
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
)

// RuntimeDestination describes a deployment-owned export destination.
type RuntimeDestination struct {
	ID          string `json:"id"`
	Label       string `json:"label"`
	Description string `json:"description,omitempty"`
	Kind        string `json:"kind"`
	Root        string `json:"root,omitempty"`
	Retention   string `json:"retention,omitempty"`
	MediaRoot   string `json:"mediaRoot,omitempty"`
}

// RuntimeSettings is the persisted server runtime configuration. It excludes
// deployment bootstrap values and credentials.
type RuntimeSettings struct {
	MediaRoots         map[string]string    `json:"mediaRoots"`
	Destinations       []RuntimeDestination `json:"destinations"`
	ExportLimit        int                  `json:"exportLimit"`
	CacheMaxBytes      int64                `json:"cacheMaxBytes"`
	PreviewGlobalLimit int                  `json:"previewGlobalLimit"`
	PreviewBeforeMS    int                  `json:"previewBeforeMs"`
	PreviewAfterMS     int                  `json:"previewAfterMs"`
	PreviewMaxMS       int                  `json:"previewMaxMs"`
	PreviewGridMS      int                  `json:"previewGridMs"`
	MediaMaxFiles      int                  `json:"mediaMaxFiles"`
	MediaMaxDepth      int                  `json:"mediaMaxDepth"`
	MCPEnabled         bool                 `json:"mcpEnabled"`
}

type RuntimeSettingsRecord struct {
	Settings      RuntimeSettings
	SchemaVersion int
	Revision      int64
	UpdatedAt     time.Time
}

// Export workers and media processes have separate safety ceilings even though
// both currently share the same numeric limit.
const (
	MaxExportWorkers  = 64
	MaxMediaProcesses = 64
)

var ErrRuntimeSettingsRevisionConflict = errors.New("runtime settings revision conflict")

// RuntimeSettingsState publishes complete snapshots to work started after an update.
// A caller must retain its captured value for the lifetime of a job.
type RuntimeSettingsState struct {
	mu       sync.RWMutex
	settings RuntimeSettings
}

func NewRuntimeSettingsState(settings RuntimeSettings) *RuntimeSettingsState {
	return &RuntimeSettingsState{settings: cloneRuntimeSettings(settings)}
}

func (s *RuntimeSettingsState) Snapshot() RuntimeSettings {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return cloneRuntimeSettings(s.settings)
}

func (s *RuntimeSettingsState) Replace(settings RuntimeSettings) {
	s.mu.Lock()
	s.settings = cloneRuntimeSettings(settings)
	s.mu.Unlock()
}

func cloneRuntimeSettings(settings RuntimeSettings) RuntimeSettings {
	roots := make(map[string]string, len(settings.MediaRoots))
	for alias, path := range settings.MediaRoots {
		roots[alias] = path
	}
	settings.MediaRoots = roots
	settings.Destinations = append([]RuntimeDestination(nil), settings.Destinations...)
	return settings
}

// ValidDestinationID applies the safety policy used for persisted destinations.
func ValidDestinationID(value string) bool {
	if strings.TrimSpace(value) == "" || len(value) > 64 || strings.ContainsAny(value, "/\\") {
		return false
	}
	for _, character := range value {
		if character < 32 || character == 127 {
			return false
		}
	}
	return true
}

// ValidateRuntimeSettings checks the complete effective document.
func ValidateRuntimeSettings(settings RuntimeSettings) error {
	if settings.MediaRoots == nil {
		return errors.New("media roots are required")
	}
	for alias, path := range settings.MediaRoots {
		if strings.TrimSpace(alias) == "" || strings.TrimSpace(path) == "" {
			return errors.New("media roots contain an empty alias or path")
		}
	}
	if settings.ExportLimit < 1 || settings.ExportLimit > MaxExportWorkers {
		return fmt.Errorf("export limit must be 1..%d", MaxExportWorkers)
	}
	if settings.CacheMaxBytes < 2 {
		return errors.New("cache limit must be at least 2 bytes")
	}
	if settings.PreviewGlobalLimit < 1 || settings.PreviewBeforeMS < 1 || settings.PreviewAfterMS < 1 || settings.PreviewMaxMS < 1 || settings.PreviewGridMS < 1 || settings.MediaMaxFiles < 1 || settings.MediaMaxDepth < 1 {
		return errors.New("runtime limits must be positive")
	}
	if settings.PreviewGlobalLimit > MaxMediaProcesses {
		return fmt.Errorf("preview global limit must be 1..%d", MaxMediaProcesses)
	}
	if settings.PreviewBeforeMS > settings.PreviewMaxMS-settings.PreviewAfterMS {
		return errors.New("preview max must cover the default preview window")
	}
	if len(settings.Destinations) == 0 {
		return errors.New("at least one destination is required")
	}
	seen := make(map[string]bool, len(settings.Destinations))
	for _, destination := range settings.Destinations {
		if !ValidDestinationID(destination.ID) || seen[destination.ID] {
			return errors.New("destinations must have unique safe IDs")
		}
		if destination.Kind != "download" && destination.Kind != "archive" && destination.Kind != "source_adjacent" {
			return errors.New("destination has an invalid kind")
		}
		if destination.Kind == "source_adjacent" {
			if strings.TrimSpace(destination.MediaRoot) == "" {
				return errors.New("source-adjacent destinations require a media root")
			}
		} else if strings.TrimSpace(destination.Root) == "" {
			return errors.New("file destinations require a root")
		}
		if destination.Retention != "" {
			retention, err := time.ParseDuration(destination.Retention)
			if err != nil || retention < 0 {
				return errors.New("destination retention must be a non-negative duration")
			}
		}
		seen[destination.ID] = true
	}
	return nil
}
