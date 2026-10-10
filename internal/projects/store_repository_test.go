package projects

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"errors"
	"path/filepath"
	"testing"

	store "videocutlist/internal/db"
	"videocutlist/internal/projects/model"
)

var (
	_ ProjectRepository     = StoreRepository{}
	_ ProjectListRepository = StoreRepository{}
)

func newStoreRepository(t *testing.T) (*sql.DB, StoreRepository) {
	t.Helper()
	database, err := store.OpenDatabase(t.Context(), filepath.Join(t.TempDir(), "projects.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := database.Close(); err != nil {
			t.Error(err)
		}
	})
	projectStore, err := store.NewProjectStore(database)
	if err != nil {
		t.Fatal(err)
	}
	return database, StoreRepository{Store: projectStore}
}

func TestStoreRepositoryRoundTripRevisionConflictAndProjectSummaries(t *testing.T) {
	_, repository := newStoreRepository(t)
	document := model.Document{
		SchemaVersion: model.ProjectSchemaVersion,
		Name:          "Round trip",
		Items: []model.ProjectItem{{
			ID:      "i_aaaaaaaaaaaaaaaaaaaaaaaa",
			MediaID: "m_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			Segments: []model.Segment{{
				ID: "s_example", StartMS: 100, EndMS: 500, Label: "keep", Included: false,
			}},
			EditorState: &model.UIState{PlayheadMS: 200, Zoom: 1.5, Muted: true},
		}},
	}

	created, err := repository.Save(t.Context(), "p_aaaaaaaaaaaa", 0, document)
	if err != nil || created.Revision != 1 {
		t.Fatalf("create = %#v, err = %v", created, err)
	}
	assertDocumentJSON(t, created.Document, document)
	loaded, err := repository.Get(t.Context(), "p_aaaaaaaaaaaa")
	if err != nil || loaded.Revision != 1 {
		t.Fatalf("get = %#v, err = %v", loaded, err)
	}
	assertDocumentJSON(t, loaded.Document, document)

	updatedDocument := document
	updatedDocument.Name = "Updated"
	updated, err := repository.Save(t.Context(), "p_aaaaaaaaaaaa", created.Revision, updatedDocument)
	if err != nil || updated.Revision != 2 {
		t.Fatalf("update = %#v, err = %v", updated, err)
	}
	if _, err := repository.Save(t.Context(), "p_aaaaaaaaaaaa", created.Revision, document); !errors.Is(err, store.ErrRevisionConflict) {
		t.Fatalf("stale save error = %v, want revision conflict", err)
	}
	if _, err := repository.Save(t.Context(), "p_aaaaaaaaaaaa", 0, document); !errors.Is(err, store.ErrRevisionConflict) {
		t.Fatalf("duplicate create error = %v, want revision conflict", err)
	}
	persisted, err := repository.Get(t.Context(), "p_aaaaaaaaaaaa")
	if err != nil || persisted.Revision != 2 || persisted.Document.Name != "Updated" {
		t.Fatalf("conflict changed persisted project: %#v, err = %v", persisted, err)
	}

	if _, err := repository.Save(t.Context(), "p_bbbbbbbbbbbb", 0, document); err != nil {
		t.Fatal(err)
	}
	page, err := (ProjectUseCase{Repository: repository}).List(t.Context(), "", 1)
	if err != nil || len(page.Items) != 1 || page.Items[0].ID != "p_aaaaaaaaaaaa" || page.Items[0].Name != "Updated" || page.Items[0].Revision != 2 || page.NextCursor == nil {
		t.Fatalf("project list = %#v, err = %v", page, err)
	}
	encodedSummary, err := json.Marshal(page.Items[0])
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(encodedSummary, &fields); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"id", "name", "revision", "updatedAt"} {
		if _, ok := fields[key]; !ok {
			t.Errorf("project summary JSON missing %q: %s", key, encodedSummary)
		}
	}
	if len(fields) != 4 {
		t.Errorf("project summary JSON has unexpected fields: %s", encodedSummary)
	}
}

func assertDocumentJSON(t *testing.T, got, want model.Document) {
	t.Helper()
	gotJSON, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	wantJSON, err := json.Marshal(want)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(gotJSON, wantJSON) {
		t.Fatalf("document JSON = %s, want %s", gotJSON, wantJSON)
	}
}
