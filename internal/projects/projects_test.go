package projects_test

import (
	"context"
	"database/sql"
	"errors"
	"testing"

	"editapp/internal/projects"
	"editapp/internal/store"
	_ "modernc.org/sqlite"
)

const mediaID = "m_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

func TestSaveUsesOwnerScopedOptimisticRevision(t *testing.T) {
	db := openDB(t)
	projectStore, err := store.NewProjectStore(db)
	if err != nil {
		t.Fatal(err)
	}
	service, err := projects.NewService(projectStore)
	if err != nil {
		t.Fatal(err)
	}
	document := projects.Document{MediaID: mediaID, UIState: projects.UIState{Zoom: 1}}
	saved, err := service.Save(context.Background(), "editor@example.com", "project-1", document, 1_000)
	if err != nil || saved.Revision != 1 {
		t.Fatalf("create = %#v, %v", saved, err)
	}
	if updated, err := service.Save(context.Background(), "editor@example.com", "project-1", saved, 1_000); err != nil || updated.Revision != 2 {
		t.Fatalf("update = %#v, %v", updated, err)
	}
	if _, err := service.Save(context.Background(), "editor@example.com", "project-1", saved, 1_000); !errors.Is(err, store.ErrRevisionConflict) {
		t.Fatalf("stale save error = %v", err)
	}
	if _, err := service.Load(context.Background(), "other@example.com", "project-1"); !errors.Is(err, store.ErrProjectNotFound) {
		t.Fatalf("cross-owner load error = %v", err)
	}
}

func TestValidateRejectsOverlappingAndOutOfRangeSegments(t *testing.T) {
	document := projects.Document{
		MediaID:  mediaID,
		Segments: []projects.Segment{{StartMS: 0, EndMS: 500}, {StartMS: 400, EndMS: 1_200}},
		UIState:  projects.UIState{Zoom: 1},
	}
	if err := projects.Validate(document, 1_000); err == nil {
		t.Fatal("overlapping and out-of-range segments were accepted")
	}
}

func TestDecodeRejectsUnknownAndMissingSchemaFields(t *testing.T) {
	valid := `{"mediaId":"` + mediaID + `","revision":0,"segments":[],"uiState":{"playheadMs":0,"zoom":1,"muted":false}}`
	if _, err := projects.Decode([]byte(valid), 1_000); err != nil {
		t.Fatalf("valid document rejected: %v", err)
	}
	if _, err := projects.Decode([]byte(`{"mediaId":"`+mediaID+`","revision":0,"segments":[],"uiState":{"playheadMs":0,"zoom":1,"muted":false},"extra":true}`), 1_000); err == nil {
		t.Fatal("unknown field accepted")
	}
}

func openDB(t *testing.T) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	if err := store.MigrateProjects(context.Background(), db); err != nil {
		t.Fatal(err)
	}
	return db
}
