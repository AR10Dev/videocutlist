package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	settingsmodel "videocutlist/internal/settings/model"
)

const runtimeSettingsSchemaVersion = 1

// RuntimeSettingsStore provides singleton settings with optimistic updates.
type RuntimeSettingsStore struct{ db *sql.DB }

func NewRuntimeSettingsStore(db *sql.DB) (*RuntimeSettingsStore, error) {
	if db == nil {
		return nil, errors.New("runtime settings database is required")
	}
	return &RuntimeSettingsStore{db: db}, nil
}

// Seed stores defaults for a new database and reads the effective record.
func (s *RuntimeSettingsStore) Seed(ctx context.Context, defaults settingsmodel.RuntimeSettings) (settingsmodel.RuntimeSettingsRecord, error) {
	if err := settingsmodel.ValidateRuntimeSettings(defaults); err != nil {
		return settingsmodel.RuntimeSettingsRecord{}, err
	}
	document, err := marshalRuntimeSettings(defaults)
	if err != nil {
		return settingsmodel.RuntimeSettingsRecord{}, err
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	_, err = s.db.ExecContext(ctx, `INSERT OR IGNORE INTO runtime_settings
(id, schema_version, revision, document_json, updated_at) VALUES (1, ?, 1, ?, ?)`, runtimeSettingsSchemaVersion, document, now)
	if err != nil {
		return settingsmodel.RuntimeSettingsRecord{}, fmt.Errorf("seed runtime settings: %w", err)
	}
	return s.Get(ctx)
}

func (s *RuntimeSettingsStore) Get(ctx context.Context) (settingsmodel.RuntimeSettingsRecord, error) {
	var version int
	var record settingsmodel.RuntimeSettingsRecord
	var document, updated string
	if err := s.db.QueryRowContext(ctx, `SELECT schema_version, revision, document_json, updated_at FROM runtime_settings WHERE id = 1`).Scan(&version, &record.Revision, &document, &updated); err != nil {
		return settingsmodel.RuntimeSettingsRecord{}, fmt.Errorf("read runtime settings: %w", err)
	}
	if version != runtimeSettingsSchemaVersion {
		return settingsmodel.RuntimeSettingsRecord{}, fmt.Errorf("unsupported runtime settings schema version %d", version)
	}
	if err := decodeRuntimeSettings(document, &record.Settings); err != nil {
		return settingsmodel.RuntimeSettingsRecord{}, fmt.Errorf("invalid stored runtime settings: %w", err)
	}
	if err := settingsmodel.ValidateRuntimeSettings(record.Settings); err != nil {
		return settingsmodel.RuntimeSettingsRecord{}, fmt.Errorf("invalid stored runtime settings: %w", err)
	}
	record.SchemaVersion = version
	var parseErr error
	record.UpdatedAt, parseErr = time.Parse(time.RFC3339Nano, updated)
	if parseErr != nil {
		return settingsmodel.RuntimeSettingsRecord{}, fmt.Errorf("invalid runtime settings timestamp: %w", parseErr)
	}
	return record, nil
}

// Update validates the complete candidate before replacing the document.
func (s *RuntimeSettingsStore) Update(ctx context.Context, expectedRevision int64, settings settingsmodel.RuntimeSettings) (settingsmodel.RuntimeSettingsRecord, error) {
	if err := settingsmodel.ValidateRuntimeSettings(settings); err != nil {
		return settingsmodel.RuntimeSettingsRecord{}, err
	}
	document, err := marshalRuntimeSettings(settings)
	if err != nil {
		return settingsmodel.RuntimeSettingsRecord{}, err
	}
	now := time.Now().UTC()
	result, err := s.db.ExecContext(ctx, `UPDATE runtime_settings SET revision = revision + 1, document_json = ?, updated_at = ? WHERE id = 1 AND revision = ?`, document, now.Format(time.RFC3339Nano), expectedRevision)
	if err != nil {
		return settingsmodel.RuntimeSettingsRecord{}, fmt.Errorf("update runtime settings: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return settingsmodel.RuntimeSettingsRecord{}, err
	}
	if affected != 1 {
		if _, getErr := s.Get(ctx); getErr != nil {
			return settingsmodel.RuntimeSettingsRecord{}, getErr
		}
		return settingsmodel.RuntimeSettingsRecord{}, settingsmodel.ErrRuntimeSettingsRevisionConflict
	}
	// The write is committed. A subsequent cancellable read could falsely report
	// failure and make the caller roll live settings back behind persisted state.
	return settingsmodel.RuntimeSettingsRecord{Settings: settings, SchemaVersion: runtimeSettingsSchemaVersion, Revision: expectedRevision + 1, UpdatedAt: now}, nil
}

func marshalRuntimeSettings(settings settingsmodel.RuntimeSettings) (string, error) {
	data, err := json.Marshal(settings)
	if err != nil {
		return "", fmt.Errorf("encode runtime settings: %w", err)
	}
	return string(data), nil
}

func decodeRuntimeSettings(document string, settings *settingsmodel.RuntimeSettings) error {
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
