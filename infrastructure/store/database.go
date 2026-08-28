package store

import (
	"context"
	"database/sql"
	_ "embed"
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
	if err := migrateSingleUserBatch(ctx, db); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("migrate single-user batch schema: %w", err)
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
			if _, err := tx.ExecContext(ctx, `INSERT INTO jobs (id,batch_id,kind,project_id,project_item_id,state,request_json,result_json,error_code,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`, id, "b_"+id, JobExport, pid, item, state, request, result, code, created, updated); err != nil {
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
			if _, err = tx.ExecContext(ctx, `INSERT INTO jobs (id,batch_id,kind,project_id,project_item_id,state,request_json,result_json,error_code,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`, id, "b_"+id, JobDetect, pid, item, state, string(request), result, code, created, updated); err != nil {
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

func migrateSingleUserBatch(ctx context.Context, db *sql.DB) error {
	var ownerColumn int
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM pragma_table_info('projects') WHERE name = 'owner_login'`).Scan(&ownerColumn); err != nil {
		return err
	}
	if ownerColumn == 0 {
		return nil
	}
	rows, err := db.QueryContext(ctx, `SELECT id, document_json, revision, created_at, updated_at FROM projects`)
	if err != nil {
		return err
	}
	type projectRow struct {
		id, document, created, updated string
		revision                       int64
	}
	var projects []projectRow
	for rows.Next() {
		var row projectRow
		if err := rows.Scan(&row.id, &row.document, &row.revision, &row.created, &row.updated); err != nil {
			rows.Close()
			return err
		}
		projects = append(projects, row)
	}
	if err := rows.Close(); err != nil {
		return err
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, `CREATE TABLE projects_batch (id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK (revision > 0), document_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`); err != nil {
		return err
	}
	for _, row := range projects {
		var legacy legacyProjectDocument
		if err := json.Unmarshal([]byte(row.document), &legacy); err != nil {
			return fmt.Errorf("decode legacy project %q: %w", row.id, err)
		}
		document, err := json.Marshal(domain.Document{SchemaVersion: domain.ProjectSchemaVersion, Name: "Untitled project", Items: []domain.ProjectItem{{ID: domain.StableProjectItemID(row.id), MediaID: legacy.MediaID, Segments: legacy.Segments, EditorState: &legacy.UIState}}})
		if err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, `INSERT INTO projects_batch (id, revision, document_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`, row.id, row.revision, document, row.created, row.updated); err != nil {
			return err
		}
	}
	for _, statement := range []string{
		`CREATE TABLE export_jobs_batch (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, project_revision INTEGER NOT NULL CHECK (project_revision > 0), state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')), request_json TEXT NOT NULL, result_json TEXT, error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
		`INSERT INTO export_jobs_batch SELECT id, project_id, project_revision, state, request_json, result_json, error_code, created_at, updated_at FROM export_jobs`,
		`CREATE TABLE detection_jobs_batch (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, media_id TEXT NOT NULL, project_revision INTEGER NOT NULL CHECK (project_revision > 0), kind TEXT NOT NULL CHECK (kind IN ('silence', 'black', 'scene')), state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')), result_json TEXT, error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
		`INSERT INTO detection_jobs_batch SELECT id, project_id, media_id, project_revision, kind, state, result_json, error_code, created_at, updated_at FROM detection_jobs`,
		`DROP TABLE export_jobs`,
		`DROP TABLE detection_jobs`,
		`DROP TABLE projects`,
		`ALTER TABLE projects_batch RENAME TO projects`,
		`CREATE TABLE export_jobs (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, project_revision INTEGER NOT NULL CHECK (project_revision > 0), state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')), request_json TEXT NOT NULL, result_json TEXT, error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, FOREIGN KEY (project_id) REFERENCES projects(id))`,
		`INSERT INTO export_jobs SELECT * FROM export_jobs_batch`,
		`DROP TABLE export_jobs_batch`,
		`CREATE INDEX export_jobs_state_updated ON export_jobs (state, updated_at)`,
		`ALTER TABLE detection_jobs_batch RENAME TO detection_jobs`,
		`CREATE INDEX detection_jobs_state_updated ON detection_jobs (state, updated_at)`,
	} {
		if _, err = tx.ExecContext(ctx, statement); err != nil {
			return err
		}
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	return nil
}
