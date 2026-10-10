package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
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
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("open database: %w", err)
	}
	db.SetMaxOpenConns(1) // ponytail: one host/user; increase only after measured DB contention.
	for _, statement := range []string{
		`PRAGMA foreign_keys = ON`,
		`PRAGMA journal_mode = WAL`,
		`PRAGMA busy_timeout = 5000`,
	} {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			return nil, errors.Join(fmt.Errorf("configure database: %w", err), db.Close())
		}
	}
	if err := migrations.Apply(ctx, db); err != nil {
		return nil, errors.Join(err, db.Close())
	}
	return db, nil
}
