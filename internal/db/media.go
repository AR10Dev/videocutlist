// Package store persists media index records in SQLite through database/sql.
package store

import (
	"cmp"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"slices"
	"strings"
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

	// Folder discovery still scans every available row because the catalog has
	// no folder index. The lightweight projection keeps decoded item state
	// bounded to limit+1 while row work remains O(library).
	rows, err := tx.QueryContext(ctx, `
SELECT id, root_alias, relative_path, size_bytes, mtime_ns
FROM media
WHERE available = 1
ORDER BY id`)
	if err != nil {
		return nil, nil, "", err
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
			err = errors.Join(err, fmt.Errorf("close media browse rows: %w", closeErr))
		}
	}()

	type browseItem struct {
		id, root, path string
		sizeBytes      int64
		mtimeNS        int64
	}
	retained := make([]browseItem, 0, limit+1)
	foldersByID := make(map[string]index.Folder)
	for rows.Next() {
		var item browseItem
		if err = rows.Scan(&item.id, &item.root, &item.path, &item.sizeBytes, &item.mtimeNS); err != nil {
			return nil, nil, "", err
		}
		parts := strings.Split(filepath.ToSlash(item.path), "/")
		for depth := range len(parts) {
			parent := strings.Join(parts[:depth], "/")
			if folderID != "" && index.FolderID(item.root, parent) != folderID {
				continue
			}
			if depth == len(parts)-1 {
				if item.id > cursor && len(retained) < limit+1 {
					retained = append(retained, item)
				}
				continue
			}
			folder := index.Folder{
				ID:    index.FolderID(item.root, strings.Join(parts[:depth+1], "/")),
				Label: parts[depth],
			}
			if _, exists := foldersByID[folder.ID]; !exists {
				foldersByID[folder.ID] = folder
			}
			break
		}
	}
	if err = rows.Err(); err != nil {
		return nil, nil, "", err
	}
	if closeErr := closeRows(); closeErr != nil {
		return nil, nil, "", fmt.Errorf("close media browse rows: %w", closeErr)
	}

	if len(foldersByID) > 0 {
		folders = make([]index.Folder, 0, len(foldersByID))
		for _, folder := range foldersByID {
			folders = append(folders, folder)
		}
		slices.SortFunc(folders, func(a, b index.Folder) int { return cmp.Compare(a.ID, b.ID) })
	}

	itemLimit := min(len(retained), limit)
	if len(retained) > limit {
		next = retained[limit-1].id
	}
	if itemLimit > 0 {
		placeholders := strings.TrimSuffix(strings.Repeat("?,", itemLimit), ",")
		args := make([]any, itemLimit)
		for i := range itemLimit {
			args[i] = retained[i].id
		}
		metadataRows, queryErr := tx.QueryContext(ctx, `
SELECT id, metadata_json
FROM media
WHERE available = 1 AND id IN (`+placeholders+`)`, args...)
		if queryErr != nil {
			return nil, nil, "", queryErr
		}
		metadataRowsClosed := false
		closeMetadataRows := func() error {
			if metadataRowsClosed {
				return nil
			}
			metadataRowsClosed = true
			return metadataRows.Close()
		}
		defer func() {
			if closeErr := closeMetadataRows(); closeErr != nil {
				err = errors.Join(err, fmt.Errorf("close media metadata rows: %w", closeErr))
			}
		}()
		metadataByID := make(map[string]index.Media, itemLimit)
		for metadataRows.Next() {
			var id, metadataJSON string
			if err = metadataRows.Scan(&id, &metadataJSON); err != nil {
				return nil, nil, "", err
			}
			var media index.Media
			if err = json.Unmarshal([]byte(metadataJSON), &media.Metadata); err != nil {
				return nil, nil, "", fmt.Errorf("decode media metadata: %w", err)
			}
			metadataByID[id] = media
		}
		if err = metadataRows.Err(); err != nil {
			return nil, nil, "", err
		}
		if closeErr := closeMetadataRows(); closeErr != nil {
			return nil, nil, "", fmt.Errorf("close media metadata rows: %w", closeErr)
		}
		items = make([]index.Media, 0, itemLimit)
		for _, retainedItem := range retained[:itemLimit] {
			media, exists := metadataByID[retainedItem.id]
			if !exists {
				return nil, nil, "", fmt.Errorf("media metadata missing for %q", retainedItem.id)
			}
			media.ID = retainedItem.id
			media.Name = fileName(retainedItem.path)
			media.SizeBytes = retainedItem.sizeBytes
			media.MtimeNS = retainedItem.mtimeNS
			items = append(items, media)
		}
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
