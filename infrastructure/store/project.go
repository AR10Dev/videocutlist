// Package store persists project documents in SQLite through database/sql.
package store

import (
	"context"
	"database/sql"
	_ "embed"
	"errors"
	"fmt"
	"time"
)

var (
	ErrProjectNotFound  = errors.New("project not found")
	ErrRevisionConflict = errors.New("project revision conflict")
)

//go:embed migrations/002_projects.sql
var projectsMigration string

type ProjectRecord struct {
	ID           string
	Revision     int64
	DocumentJSON string
	CreatedAt    time.Time
	UpdatedAt    time.Time
}

type ProjectStore struct{ db *sql.DB }

func NewProjectStore(db *sql.DB) (*ProjectStore, error) {
	if db == nil {
		return nil, errors.New("project database is required")
	}
	return &ProjectStore{db: db}, nil
}

// MigrateProjects applies the E01 project schema. Call after migration 001.
func MigrateProjects(ctx context.Context, db *sql.DB) error {
	if db == nil {
		return errors.New("project database is required")
	}
	_, err := db.ExecContext(ctx, projectsMigration)
	return err
}

func (s *ProjectStore) Get(ctx context.Context, id string) (ProjectRecord, error) {
	row := s.db.QueryRowContext(ctx, `SELECT id, revision, document_json, created_at, updated_at
FROM projects WHERE id = ?`, id)
	record, err := scanProject(row)
	if errors.Is(err, sql.ErrNoRows) {
		return ProjectRecord{}, ErrProjectNotFound
	}
	return record, err
}

// Save creates at revision zero and otherwise conditionally increments revision.
func (s *ProjectStore) Save(ctx context.Context, id string, expectedRevision int64, documentJSON string) (ProjectRecord, error) {
	if id == "" || expectedRevision < 0 {
		return ProjectRecord{}, errors.New("project id and revision are required")
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	if expectedRevision == 0 {
		_, err := s.db.ExecContext(ctx, `INSERT INTO projects
(id, revision, document_json, created_at, updated_at) VALUES (?, 1, ?, ?, ?)`, id, documentJSON, now, now)
		if err == nil {
			return s.Get(ctx, id)
		}
		if _, existingErr := s.Get(ctx, id); existingErr == nil {
			return ProjectRecord{}, ErrRevisionConflict
		} else if !errors.Is(existingErr, ErrProjectNotFound) {
			return ProjectRecord{}, existingErr
		}
		if exists, existsErr := s.idExists(ctx, id); existsErr != nil {
			return ProjectRecord{}, existsErr
		} else if exists {
			return ProjectRecord{}, ErrProjectNotFound
		}
		return ProjectRecord{}, fmt.Errorf("create project: %w", err)
	}
	result, err := s.db.ExecContext(ctx, `UPDATE projects SET revision = revision + 1, document_json = ?, updated_at = ?
WHERE id = ? AND revision = ?`, documentJSON, now, id, expectedRevision)
	if err != nil {
		return ProjectRecord{}, fmt.Errorf("update project: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return ProjectRecord{}, err
	}
	if affected == 1 {
		return s.Get(ctx, id)
	}
	if _, existingErr := s.Get(ctx, id); existingErr == nil {
		return ProjectRecord{}, ErrRevisionConflict
	} else if !errors.Is(existingErr, ErrProjectNotFound) {
		return ProjectRecord{}, existingErr
	}
	return ProjectRecord{}, ErrProjectNotFound
}

func (s *ProjectStore) idExists(ctx context.Context, id string) (bool, error) {
	var one int
	err := s.db.QueryRowContext(ctx, `SELECT 1 FROM projects WHERE id = ?`, id).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

type projectScanner interface{ Scan(...any) error }

func scanProject(row projectScanner) (ProjectRecord, error) {
	var record ProjectRecord
	var created, updated string
	if err := row.Scan(&record.ID, &record.Revision, &record.DocumentJSON, &created, &updated); err != nil {
		return ProjectRecord{}, err
	}
	var err error
	if record.CreatedAt, err = time.Parse(time.RFC3339Nano, created); err != nil {
		return ProjectRecord{}, err
	}
	if record.UpdatedAt, err = time.Parse(time.RFC3339Nano, updated); err != nil {
		return ProjectRecord{}, err
	}
	return record, nil
}
