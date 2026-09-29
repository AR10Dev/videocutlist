// Package store persists media index records in SQLite through database/sql.
package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"time"

	"videocutlist/internal/library/media/index"
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
func (s *MediaStore) Sync(ctx context.Context, alias string, records []index.Record) (err error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() {
		if rollbackErr := tx.Rollback(); rollbackErr != nil && !errors.Is(rollbackErr, sql.ErrTxDone) {
			err = errors.Join(err, fmt.Errorf("rollback media sync: %w", rollbackErr))
		}
	}()
	now := time.Now().UTC().Format(time.RFC3339Nano)
	if _, err := tx.ExecContext(ctx, `UPDATE media SET available = 0, updated_at = ? WHERE root_alias = ?`, now, alias); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE media_folders SET available = 0 WHERE root_alias = ?`, alias); err != nil {
		return err
	}
	type storedFolder struct{ parent, label string }
	folders := make(map[string]storedFolder)
	for _, record := range records {
		relative := filepath.ToSlash(record.RelativePath)
		parentID := ""
		start := 0
		for i := range len(relative) {
			if relative[i] != '/' {
				continue
			}
			id := index.FolderID(alias, relative[:i])
			folders[id] = storedFolder{parent: parentID, label: relative[start:i]}
			parentID = id
			start = i + 1
		}
		metadata, err := json.Marshal(record.Metadata)
		if err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `
INSERT INTO media (id, root_alias, relative_path, parent_folder_id, size_bytes, mtime_ns, metadata_json, available, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
ON CONFLICT(root_alias, relative_path) DO UPDATE SET
 id=excluded.id, parent_folder_id=excluded.parent_folder_id,
 size_bytes=excluded.size_bytes, mtime_ns=excluded.mtime_ns,
 metadata_json=excluded.metadata_json, available=1, updated_at=excluded.updated_at`,
			record.ID, alias, record.RelativePath, parentID, record.SizeBytes, record.MtimeNS, string(metadata), now, now)
		if err != nil {
			return err
		}
	}
	for id, folder := range folders {
		if _, err := tx.ExecContext(ctx, `
INSERT INTO media_folders (id, root_alias, parent_folder_id, label, available)
VALUES (?, ?, ?, ?, 1)
ON CONFLICT(id) DO UPDATE SET
 root_alias=excluded.root_alias, parent_folder_id=excluded.parent_folder_id,
 label=excluded.label, available=1`,
			id, alias, folder.parent, folder.label); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// RemoveRoots atomically makes records from removed roots unavailable without
// exposing filesystem paths or deleting historical opaque IDs.
func (s *MediaStore) RemoveRoots(ctx context.Context, aliases []string) (err error) {
	if len(aliases) == 0 {
		return nil
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() {
		if rollbackErr := tx.Rollback(); rollbackErr != nil && !errors.Is(rollbackErr, sql.ErrTxDone) {
			err = errors.Join(err, fmt.Errorf("rollback media root removal: %w", rollbackErr))
		}
	}()
	now := time.Now().UTC().Format(time.RFC3339Nano)
	for _, alias := range aliases {
		if _, err := tx.ExecContext(ctx, `UPDATE media SET available = 0, updated_at = ? WHERE root_alias = ?`, now, alias); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE media_folders SET available = 0 WHERE root_alias = ?`, alias); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// ReconcileRoots hides indexed media whose root aliases are absent from the
// effective deployment configuration, including when no roots are configured.
func (s *MediaStore) ReconcileRoots(ctx context.Context, configured map[string]string) error {
	rows, err := s.db.QueryContext(ctx, `SELECT DISTINCT root_alias FROM media WHERE available = 1`)
	if err != nil {
		return err
	}
	var removed []string
	for rows.Next() {
		var alias string
		if err := rows.Scan(&alias); err != nil {
			_ = rows.Close()
			return err
		}
		if _, ok := configured[alias]; !ok {
			removed = append(removed, alias)
		}
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return err
	}
	if err := rows.Close(); err != nil {
		return err
	}
	return s.RemoveRoots(ctx, removed)
}

func (s *MediaStore) Get(ctx context.Context, id string) (index.Record, error) {
	row := s.db.QueryRowContext(ctx, `SELECT id, root_alias, relative_path, size_bytes, mtime_ns, metadata_json FROM media WHERE id = ? AND available = 1`, id)
	record, err := scanMedia(row)
	if errors.Is(err, sql.ErrNoRows) {
		return index.Record{}, ErrMediaNotFound
	}
	return record, err
}

// Browse returns direct children of an opaque virtual folder. Paths stay inside
// this package and are never serialized.
func (s *MediaStore) Browse(ctx context.Context, folderID, cursor string, limit int) (folders []index.Folder, items []index.Media, next string, err error) {
	if limit <= 0 {
		limit = 100
	}
	if limit > 500 {
		limit = 500
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, nil, "", err
	}
	defer func() {
		if rollbackErr := tx.Rollback(); rollbackErr != nil && !errors.Is(rollbackErr, sql.ErrTxDone) {
			err = errors.Join(err, fmt.Errorf("rollback media browse: %w", rollbackErr))
		}
	}()

	folderRows, err := tx.QueryContext(ctx, `
SELECT id, label FROM media_folders
WHERE available = 1 AND parent_folder_id = ?
ORDER BY id`, folderID)
	if err != nil {
		return nil, nil, "", err
	}
	defer func() {
		if closeErr := folderRows.Close(); closeErr != nil {
			err = errors.Join(err, fmt.Errorf("close media folder rows: %w", closeErr))
		}
	}()
	for folderRows.Next() {
		var folder index.Folder
		if err = folderRows.Scan(&folder.ID, &folder.Label); err != nil {
			return nil, nil, "", err
		}
		folders = append(folders, folder)
	}
	if err = folderRows.Err(); err != nil {
		return nil, nil, "", err
	}
	if closeErr := folderRows.Close(); closeErr != nil {
		return nil, nil, "", fmt.Errorf("close media folder rows: %w", closeErr)
	}

	itemRows, err := tx.QueryContext(ctx, `
SELECT id, relative_path, size_bytes, mtime_ns, metadata_json
FROM media
WHERE available = 1 AND parent_folder_id = ? AND id > ?
ORDER BY id LIMIT ?`, folderID, cursor, limit+1)
	if err != nil {
		return nil, nil, "", err
	}
	defer func() {
		if closeErr := itemRows.Close(); closeErr != nil {
			err = errors.Join(err, fmt.Errorf("close media browse rows: %w", closeErr))
		}
	}()
	for itemRows.Next() {
		var media index.Media
		var relative string
		var metadataJSON []byte
		if err = itemRows.Scan(&media.ID, &relative, &media.SizeBytes, &media.MtimeNS, &metadataJSON); err != nil {
			return nil, nil, "", err
		}
		if len(items) == limit {
			next = items[len(items)-1].ID
			break
		}
		if err = json.Unmarshal(metadataJSON, &media.Metadata); err != nil {
			return nil, nil, "", fmt.Errorf("decode media metadata: %w", err)
		}
		media.Name = fileName(relative)
		items = append(items, media)
	}
	if err = itemRows.Err(); err != nil {
		return nil, nil, "", err
	}
	if closeErr := itemRows.Close(); closeErr != nil {
		return nil, nil, "", fmt.Errorf("close media browse rows: %w", closeErr)
	}
	if err = tx.Commit(); err != nil {
		return nil, nil, "", err
	}
	return folders, items, next, nil
}

func (s *MediaStore) List(ctx context.Context, cursor string, limit int) (page index.Page, err error) {
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
	rowsClosed := false
	closeRows := func() error {
		if rowsClosed {
			return nil
		}
		rowsClosed = true
		return rows.Close()
	}
	defer func() {
		if closeErr := closeRows(); closeErr != nil {
			err = errors.Join(err, fmt.Errorf("close media list rows: %w", closeErr))
		}
	}()
	page = index.Page{}
	for rows.Next() {
		record, err := scanMedia(rows)
		if err != nil {
			return index.Page{}, err
		}
		if len(page.Items) == limit {
			page.NextCursor = page.Items[len(page.Items)-1].ID
			if closeErr := closeRows(); closeErr != nil {
				return index.Page{}, fmt.Errorf("close media list rows: %w", closeErr)
			}
			return page, nil
		}
		page.Items = append(page.Items, record.Media)
	}
	if err := rows.Err(); err != nil {
		return index.Page{}, err
	}
	if closeErr := closeRows(); closeErr != nil {
		return index.Page{}, fmt.Errorf("close media list rows: %w", closeErr)
	}
	return page, nil
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
