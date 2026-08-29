package store

import (
	"context"
	"crypto/sha256"
	"database/sql"
	_ "embed"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"videocutlist/domain"

	_ "modernc.org/sqlite"
)

//go:embed migrations/001_media.sql
var mediaMigration string

//go:embed migrations/004_cache.sql
var cacheMigration string

//go:embed migrations/005_detection_jobs.sql
var detectionJobsMigration string

//go:embed migrations/006_runtime_settings.sql
var runtimeSettingsMigration string

//go:embed migrations/007_jobs.sql
var unifiedJobsMigration string

// OpenDatabase opens the single-host SQLite store and applies ordered,
// idempotent migrations.
func OpenDatabase(ctx context.Context, path string) (*sql.DB, error) {
	if path == "" {
		return nil, fmt.Errorf("database path is required")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		return nil, fmt.Errorf("create database directory: %w", err)
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1) // ponytail: one host/user; increase only after measured DB contention.
	for _, statement := range []string{
		`PRAGMA foreign_keys = ON`,
		`PRAGMA journal_mode = WAL`,
		`PRAGMA busy_timeout = 5000`,
		mediaMigration,
		projectsMigration,
		jobsMigration,
		cacheMigration,
		detectionJobsMigration,
		runtimeSettingsMigration,
		unifiedJobsMigration,
	} {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			_ = db.Close()
			return nil, fmt.Errorf("migrate database: %w", err)
		}
	}
	if err := migrateLegacyIdentityColumns(ctx, db); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("migrate legacy identity columns: %w", err)
	}
	if err := migrateUnifiedJobs(ctx, db); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("migrate unified jobs: %w", err)
	}
	return db, nil
}

type legacyProjectDocument struct {
	MediaID  string           `json:"mediaId"`
	Segments []domain.Segment `json:"segments"`
	UIState  domain.UIState   `json:"uiState"`
}

func migrateUnifiedJobs(ctx context.Context, db *sql.DB) error {
	var existing int
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM jobs`).Scan(&existing); err != nil || existing != 0 {
		return err
	}
	items := make(map[string]string)
	rows, err := db.QueryContext(ctx, `SELECT id, document_json FROM projects`)
	if err != nil {
		return err
	}
	for rows.Next() {
		var id, raw string
		if err := rows.Scan(&id, &raw); err != nil {
			rows.Close()
			return err
		}
		var document domain.Document
		if err := json.Unmarshal([]byte(raw), &document); err != nil {
			rows.Close()
			return err
		}
		if len(document.Items) > 0 {
			items[id] = document.Items[0].ID
		}
	}
	if err := rows.Close(); err != nil {
		return err
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	copyExport := func() error {
		rows, err := tx.QueryContext(ctx, `SELECT id,project_id,state,request_json,result_json,error_code,created_at,updated_at FROM export_jobs`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var id, pid, state, request, created, updated string
			var result, code sql.NullString
			if err := rows.Scan(&id, &pid, &state, &request, &result, &code, &created, &updated); err != nil {
				return err
			}
			item := items[pid]
			if item == "" {
				return fmt.Errorf("legacy export job %q has no project item", id)
			}
			unifiedID := legacyUnifiedJobID(JobExport, id)
			if _, err := tx.ExecContext(ctx, `INSERT INTO jobs (id,batch_id,kind,project_id,project_item_id,state,request_json,result_json,error_code,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`, unifiedID, "b_"+unifiedID, JobExport, pid, item, state, request, result, code, created, updated); err != nil {
				return err
			}
		}
		return rows.Err()
	}
	copyDetection := func() error {
		rows, err := tx.QueryContext(ctx, `SELECT id,project_id,media_id,kind,state,result_json,error_code,created_at,updated_at FROM detection_jobs`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var id, pid, media, kind, state, created, updated string
			var result, code sql.NullString
			if err := rows.Scan(&id, &pid, &media, &kind, &state, &result, &code, &created, &updated); err != nil {
				return err
			}
			item := items[pid]
			if item == "" {
				return fmt.Errorf("legacy detection job %q has no project item", id)
			}
			request, err := json.Marshal(map[string]string{"mediaId": media, "kind": kind})
			if err != nil {
				return err
			}
			unifiedID := legacyUnifiedJobID(JobDetect, id)
			if _, err = tx.ExecContext(ctx, `INSERT INTO jobs (id,batch_id,kind,project_id,project_item_id,state,request_json,result_json,error_code,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`, unifiedID, "b_"+unifiedID, JobDetect, pid, item, state, string(request), result, code, created, updated); err != nil {
				return err
			}
		}
		return rows.Err()
	}
	if err := copyExport(); err != nil {
		return err
	}
	if err := copyDetection(); err != nil {
		return err
	}
	return tx.Commit()
}

func migrateLegacyIdentityColumns(ctx context.Context, db *sql.DB) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, table := range []string{"media", "projects", "export_jobs", "detection_jobs", "jobs", "cache_entries", "runtime_settings"} {
		for _, column := range []string{"owner_login", "principal", "role", "capability"} {
			var present int
			if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM pragma_table_info(?) WHERE name = ?`, table, column).Scan(&present); err != nil {
				return err
			}
			if present == 1 {
				if _, err := tx.ExecContext(ctx, `ALTER TABLE `+table+` DROP COLUMN `+column); err != nil {
					return fmt.Errorf("drop %s.%s: %w", table, column, err)
				}
			}
		}
	}
	return tx.Commit()
}

// legacyUnifiedJobID keeps independent legacy ID namespaces distinct without
// carrying legacy IDs or filesystem data into the shared job namespace.
func legacyUnifiedJobID(kind JobKind, id string) string {
	sum := sha256.Sum256([]byte(string(kind) + "\x00" + id))
	return "j_" + base64.RawURLEncoding.EncodeToString(sum[:])
}
