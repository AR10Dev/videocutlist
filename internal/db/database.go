package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"

	"videocutlist/internal/db/migrations"

	_ "modernc.org/sqlite"
)

// OpenDatabase opens the single-host SQLite store and applies Goose migrations.
// Development databases created before the Goose baseline must be reset.
func OpenDatabase(ctx context.Context, path string) (*sql.DB, error) {
	if path == "" {
		return nil, errors.New("database path is required")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		return nil, fmt.Errorf("create database directory: %w", err)
	}
	absolutePath, err := filepath.Abs(path)
	if err != nil {
		return nil, fmt.Errorf("resolve database path: %w", err)
	}
	dsn := (&url.URL{
		Scheme: "file", Path: absolutePath,
		RawQuery: "_foreign_keys=on&_busy_timeout=5000&_journal_mode=wal",
	}).String()
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open database: %w", err)
	}
	db.SetMaxOpenConns(1) // ponytail: one host/user; increase only after measured DB contention.
	if err := migrations.Apply(ctx, db); err != nil {
		return nil, errors.Join(err, db.Close())
	}
	return db, nil
}
