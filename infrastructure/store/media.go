// Package store persists media index records in SQLite through database/sql.
package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"videocutlist/infrastructure/media/index"
)

var ErrMediaNotFound = index.ErrNotFound

type MediaStore struct{ db *sql.DB }

func NewMediaStore(db *sql.DB) (*MediaStore, error) {
	if db == nil {
		return nil, errors.New("media database is required")
	}
	return &MediaStore{db: db}, nil
}

// Sync makes a successful root scan authoritative: absent rows become unavailable.
func (s *MediaStore) Sync(ctx context.Context, alias string, records []index.Record) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	now := time.Now().UTC().Format(time.RFC3339Nano)
	if _, err := tx.ExecContext(ctx, `UPDATE media SET available = 0, updated_at = ? WHERE root_alias = ?`, now, alias); err != nil {
		return err
	}
	for _, record := range records {
		metadata, err := json.Marshal(record.Metadata)
		if err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `
INSERT INTO media (id, root_alias, relative_path, size_bytes, mtime_ns, metadata_json, available, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
ON CONFLICT(root_alias, relative_path) DO UPDATE SET
 id=excluded.id, size_bytes=excluded.size_bytes, mtime_ns=excluded.mtime_ns,
 metadata_json=excluded.metadata_json, available=1, updated_at=excluded.updated_at`,
			record.ID, alias, record.RelativePath, record.SizeBytes, record.MtimeNS, string(metadata), now, now)
		if err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (s *MediaStore) Get(ctx context.Context, id string) (index.Record, error) {
	row := s.db.QueryRowContext(ctx, `SELECT id, root_alias, relative_path, size_bytes, mtime_ns, metadata_json FROM media WHERE id = ? AND available = 1`, id)
	record, err := scanMedia(row)
	if errors.Is(err, sql.ErrNoRows) {
		return index.Record{}, ErrMediaNotFound
	}
	return record, err
}

func (s *MediaStore) List(ctx context.Context, cursor string, limit int) (index.Page, error) {
	if limit <= 0 {
		limit = 100
	}
	if limit > 500 {
		limit = 500
	}
	rows, err := s.db.QueryContext(ctx, `
SELECT id, root_alias, relative_path, size_bytes, mtime_ns, metadata_json
FROM media WHERE available = 1 AND id > ? ORDER BY id LIMIT ?`, cursor, limit+1)
	if err != nil {
		return index.Page{}, err
	}
	defer rows.Close()
	page := index.Page{Items: make([]index.Media, 0, limit)}
	for rows.Next() {
		record, err := scanMedia(rows)
		if err != nil {
			return index.Page{}, err
		}
		if len(page.Items) == limit {
			page.NextCursor = page.Items[len(page.Items)-1].ID
			return page, nil
		}
		page.Items = append(page.Items, record.Media)
	}
	return page, rows.Err()
}

type rowScanner interface{ Scan(...any) error }

func scanMedia(row rowScanner) (index.Record, error) {
	var record index.Record
	var metadataJSON string
	if err := row.Scan(&record.ID, &record.RootAlias, &record.RelativePath, &record.SizeBytes, &record.MtimeNS, &metadataJSON); err != nil {
		return index.Record{}, err
	}
	if err := json.Unmarshal([]byte(metadataJSON), &record.Metadata); err != nil {
		return index.Record{}, fmt.Errorf("decode media metadata: %w", err)
	}
	record.Name = fileName(record.RelativePath)
	return record, nil
}

func fileName(relative string) string {
	for i := len(relative) - 1; i >= 0; i-- {
		if relative[i] == '/' {
			return relative[i+1:]
		}
	}
	return relative
}

var _ index.Catalog = (*MediaStore)(nil)
