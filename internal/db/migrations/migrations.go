// Package migrations owns the application's embedded Goose schema history.
package migrations

import (
	"context"
	"database/sql"
	"embed"
	"errors"
	"fmt"
	"io/fs"

	"github.com/pressly/goose/v3"
)

//go:embed *.sql
var schema embed.FS

// Apply initializes a fresh development database or applies pending Goose migrations.
// Pre-Goose databases are deliberately unsupported; the operator must reset them.
func Apply(ctx context.Context, db *sql.DB) error {
	var legacy bool
	if err := db.QueryRowContext(ctx, `SELECT EXISTS (
		SELECT 1 FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
	) AND NOT EXISTS (
		SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'goose_db_version'
	)`).Scan(&legacy); err != nil {
		return fmt.Errorf("inspect database schema: %w", err)
	}
	if legacy {
		return errors.New("pre-Goose development database is unsupported; stop the server and remove the database and its -wal/-shm files, or configure a new database path")
	}
	if err := apply(ctx, db, schema); err != nil {
		return err
	}
	return nil
}

func apply(ctx context.Context, db *sql.DB, migrations fs.FS) error {
	provider, err := goose.NewProvider(goose.DialectSQLite3, db, migrations)
	if err != nil {
		return fmt.Errorf("create migration provider: %w", err)
	}
	if _, err := provider.Up(ctx); err != nil {
		return fmt.Errorf("apply schema migrations: %w", err)
	}
	return nil
}
