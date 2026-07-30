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
	OwnerLogin   string
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

func (s *ProjectStore) Get(ctx context.Context, owner, id string) (ProjectRecord, error) {
	row := s.db.QueryRowContext(ctx, `SELECT id, owner_login, revision, document_json, created_at, updated_at
FROM projects WHERE id = ? AND owner_login = ?`, id, owner)
	record, err := scanProject(row)
	if errors.Is(err, sql.ErrNoRows) {
		return ProjectRecord{}, ErrProjectNotFound // Do not reveal a different owner's project.
	}
	return record, err
}

// Save creates at revision zero and otherwise conditionally increments revision.
func (s *ProjectStore) Save(ctx context.Context, owner, id string, expectedRevision int64, documentJSON string) (ProjectRecord, error) {
	if owner == "" || id == "" || expectedRevision < 0 {
		return ProjectRecord{}, errors.New("project owner, id, and revision are required")
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	if expectedRevision == 0 {
		_, err := s.db.ExecContext(ctx, `INSERT INTO projects
(id, owner_login, revision, document_json, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?)`, id, owner, documentJSON, now, now)
		if err == nil {
			return s.Get(ctx, owner, id)
		}
		if _, ownerErr := s.Get(ctx, owner, id); ownerErr == nil {
			return ProjectRecord{}, ErrRevisionConflict
		} else if !errors.Is(ownerErr, ErrProjectNotFound) {
			return ProjectRecord{}, ownerErr
		}
		if exists, existsErr := s.idExists(ctx, id); existsErr != nil {
			return ProjectRecord{}, existsErr
		} else if exists {
			return ProjectRecord{}, ErrProjectNotFound
		}
		return ProjectRecord{}, fmt.Errorf("create project: %w", err)
	}
	result, err := s.db.ExecContext(ctx, `UPDATE projects SET revision = revision + 1, document_json = ?, updated_at = ?
WHERE id = ? AND owner_login = ? AND revision = ?`, documentJSON, now, id, owner, expectedRevision)
	if err != nil {
		return ProjectRecord{}, fmt.Errorf("update project: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return ProjectRecord{}, err
	}
	if affected == 1 {
		return s.Get(ctx, owner, id)
	}
	if _, ownerErr := s.Get(ctx, owner, id); ownerErr == nil {
		return ProjectRecord{}, ErrRevisionConflict
	} else if !errors.Is(ownerErr, ErrProjectNotFound) {
		return ProjectRecord{}, ownerErr
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
	if err := row.Scan(&record.ID, &record.OwnerLogin, &record.Revision, &record.DocumentJSON, &created, &updated); err != nil {
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
