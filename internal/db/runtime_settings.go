package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"slices"
	"strings"
	"sync"
	"time"
)

const runtimeSettingsSchemaVersion = 1

type RuntimeDestination struct {
	ID          string `json:"id"`
	Label       string `json:"label"`
	Description string `json:"description,omitempty"`
	Kind        string `json:"kind"`
	Root        string `json:"root,omitempty"`
	Retention   string `json:"retention,omitempty"`
	MediaRoot   string `json:"mediaRoot,omitempty"`
}

// RuntimeSettings is the typed, persisted server runtime configuration. It
// deliberately excludes deployment bootstrap values and credentials.
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
}

type RuntimeSettingsRecord struct {
	Settings      RuntimeSettings
	SchemaVersion int
	Revision      int64
	UpdatedAt     time.Time
}

// RuntimeSettingsState publishes complete snapshots to work started after an update.
// A caller must retain its captured value for the lifetime of a job.
type RuntimeSettingsState struct {
	mu       sync.RWMutex
	settings RuntimeSettings
}

func NewRuntimeSettingsState(settings RuntimeSettings) *RuntimeSettingsState {
	return &RuntimeSettingsState{settings: settings}
}

func (s *RuntimeSettingsState) Snapshot() RuntimeSettings {
	s.mu.RLock()
	defer s.mu.RUnlock()
	settings := s.settings
	settings.MediaRoots = make(map[string]string, len(s.settings.MediaRoots))
	for alias, path := range s.settings.MediaRoots {
		settings.MediaRoots[alias] = path
	}
	settings.Destinations = slices.Clone(s.settings.Destinations)
	return settings
}

func (s *RuntimeSettingsState) Replace(settings RuntimeSettings) {
	s.mu.Lock()
	s.settings = settings
	s.mu.Unlock()
}

var ErrRuntimeSettingsRevisionConflict = errors.New("runtime settings revision conflict")

// RuntimeSettingsStore provides singleton settings with optimistic updates.
type RuntimeSettingsStore struct{ db *sql.DB }

func NewRuntimeSettingsStore(db *sql.DB) (*RuntimeSettingsStore, error) {
	if db == nil {
		return nil, errors.New("runtime settings database is required")
	}
	return &RuntimeSettingsStore{db: db}, nil
}

// Seed stores defaults only when this database has no runtime settings.
func (s *RuntimeSettingsStore) Seed(ctx context.Context, defaults RuntimeSettings) (RuntimeSettingsRecord, error) {
	if err := ValidateRuntimeSettings(defaults); err != nil {
		return RuntimeSettingsRecord{}, err
	}
	document, err := marshalRuntimeSettings(defaults)
	if err != nil {
		return RuntimeSettingsRecord{}, err
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	_, err = s.db.ExecContext(ctx, `INSERT OR IGNORE INTO runtime_settings
(id, schema_version, revision, document_json, updated_at) VALUES (1, ?, 1, ?, ?)`, runtimeSettingsSchemaVersion, document, now)
	if err != nil {
		return RuntimeSettingsRecord{}, fmt.Errorf("seed runtime settings: %w", err)
	}
	return s.Get(ctx)
}

func (s *RuntimeSettingsStore) Get(ctx context.Context) (RuntimeSettingsRecord, error) {
	var version int
	var record RuntimeSettingsRecord
	var document, updated string
	if err := s.db.QueryRowContext(ctx, `SELECT schema_version, revision, document_json, updated_at FROM runtime_settings WHERE id = 1`).Scan(&version, &record.Revision, &document, &updated); err != nil {
		return RuntimeSettingsRecord{}, fmt.Errorf("read runtime settings: %w", err)
	}
	if version != runtimeSettingsSchemaVersion {
		return RuntimeSettingsRecord{}, fmt.Errorf("unsupported runtime settings schema version %d", version)
	}
	if err := decodeRuntimeSettings(document, &record.Settings); err != nil {
		return RuntimeSettingsRecord{}, fmt.Errorf("invalid stored runtime settings: %w", err)
	}
	if err := ValidateRuntimeSettings(record.Settings); err != nil {
		return RuntimeSettingsRecord{}, fmt.Errorf("invalid stored runtime settings: %w", err)
	}
	record.SchemaVersion = version
	var parseErr error
	record.UpdatedAt, parseErr = time.Parse(time.RFC3339Nano, updated)
	if parseErr != nil {
		return RuntimeSettingsRecord{}, fmt.Errorf("invalid runtime settings timestamp: %w", parseErr)
	}
	return record, nil
}

// Update validates the complete candidate before replacing the document.
func (s *RuntimeSettingsStore) Update(ctx context.Context, expectedRevision int64, settings RuntimeSettings) (RuntimeSettingsRecord, error) {
	if err := ValidateRuntimeSettings(settings); err != nil {
		return RuntimeSettingsRecord{}, err
	}
	document, err := marshalRuntimeSettings(settings)
	if err != nil {
		return RuntimeSettingsRecord{}, err
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	result, err := s.db.ExecContext(ctx, `UPDATE runtime_settings SET revision = revision + 1, document_json = ?, updated_at = ? WHERE id = 1 AND revision = ?`, document, now, expectedRevision)
	if err != nil {
		return RuntimeSettingsRecord{}, fmt.Errorf("update runtime settings: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return RuntimeSettingsRecord{}, err
	}
	if affected != 1 {
		if _, getErr := s.Get(ctx); getErr != nil {
			return RuntimeSettingsRecord{}, getErr
		}
		return RuntimeSettingsRecord{}, ErrRuntimeSettingsRevisionConflict
	}
	return s.Get(ctx)
}

func marshalRuntimeSettings(settings RuntimeSettings) (string, error) {
	data, err := json.Marshal(settings)
	if err != nil {
		return "", fmt.Errorf("encode runtime settings: %w", err)
	}
	return string(data), nil
}

func decodeRuntimeSettings(document string, settings *RuntimeSettings) error {
	decoder := json.NewDecoder(strings.NewReader(document))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(settings); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return errors.New("trailing JSON data")
	}
	return nil
}

func validRuntimeDestinationID(value string) bool {
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
	if settings.ExportLimit < 1 || settings.CacheMaxBytes < 1 || settings.PreviewGlobalLimit < 1 || settings.PreviewBeforeMS < 1 || settings.PreviewAfterMS < 1 || settings.PreviewMaxMS < 1 || settings.PreviewGridMS < 1 || settings.MediaMaxFiles < 1 || settings.MediaMaxDepth < 1 {
		return errors.New("runtime limits must be positive")
	}
	if settings.PreviewBeforeMS+settings.PreviewAfterMS > settings.PreviewMaxMS {
		return errors.New("preview max must cover the default preview window")
	}
	if len(settings.Destinations) == 0 {
		return errors.New("at least one destination is required")
	}
	seen := make(map[string]bool, len(settings.Destinations))
	for _, destination := range settings.Destinations {
		if !validRuntimeDestinationID(destination.ID) || seen[destination.ID] {
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
