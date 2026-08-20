package store

import (
	"context"
	"database/sql"
	_ "embed"
	"fmt"
	"os"
	"path/filepath"

	_ "modernc.org/sqlite"
)

//go:embed migrations/001_media.sql
var mediaMigration string

//go:embed migrations/004_cache.sql
var cacheMigration string

//go:embed migrations/005_detection_jobs.sql
var detectionJobsMigration string

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
	} {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			_ = db.Close()
			return nil, fmt.Errorf("migrate database: %w", err)
		}
	}
	return db, nil
}
