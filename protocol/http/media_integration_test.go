package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"videocutlist/application"
	"videocutlist/infrastructure/adapters"
	"videocutlist/infrastructure/media/index"
	"videocutlist/infrastructure/media/probe"
	"videocutlist/infrastructure/store"
)

type integrationProbe struct{}

func (integrationProbe) ProbeFile(context.Context, *os.File) (probe.Metadata, error) {
	return probe.Metadata{DurationMS: 1000, Container: "mp4", Video: &probe.Video{Codec: "h264", Width: 320, Height: 180}}, nil
}

func TestMediaTreeUsesProductionMediaUseCaseWiring(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "nested"), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "nested", "clip.mp4"), []byte("test"), 0o640); err != nil {
		t.Fatal(err)
	}
	db, err := store.OpenDatabase(context.Background(), filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	mediaStore, err := store.NewMediaStore(db)
	if err != nil {
		t.Fatal(err)
	}
	scanner, err := index.NewScanner([]index.Root{{Alias: "library", Path: root}}, integrationProbe{})
	if err != nil {
		t.Fatal(err)
	}
	media := &application.MediaUseCase{Catalog: adapters.MediaCatalog{Scanner: scanner, Store: mediaStore}, Configured: true}
	if err := media.RefreshMedia(context.Background()); err != nil {
		t.Fatal(err)
	}
	authenticator, err := NewAuthenticator(AuthConfig{Mode: "none"})
	if err != nil {
		t.Fatal(err)
	}
	server, err := New(Config{Authenticator: authenticator, Media: media, Preview: routeTestPreview{}, Projects: routeTestProjects{}, Exports: routeTestExports{}, Jobs: routeTestJobs{}})
	if err != nil {
		t.Fatal(err)
	}

	getTree := func(path string) map[string]any {
		recorder := httptest.NewRecorder()
		server.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, path, nil))
		if recorder.Code != http.StatusOK {
			t.Fatalf("GET %s status=%d, want %d: %s", path, recorder.Code, http.StatusOK, recorder.Body.String())
		}
		var page map[string]any
		if err := json.NewDecoder(recorder.Body).Decode(&page); err != nil {
			t.Fatal(err)
		}
		return page
	}
	rootPage := getTree("/api/v1/media/tree")
	folders, ok := rootPage["folders"].([]any)
	if !ok || len(folders) != 1 {
		t.Fatalf("root folders=%#v, want one opaque folder", rootPage["folders"])
	}
	folder, ok := folders[0].(map[string]any)
	if !ok {
		t.Fatalf("folder=%#v", folders[0])
	}
	folderID, ok := folder["id"].(string)
	if !ok || !strings.HasPrefix(folderID, "f_") {
		t.Fatalf("folder id=%q, want opaque ID", folder["id"])
	}
	nestedPage := getTree("/api/v1/media/tree?folderId=" + folderID)
	items, ok := nestedPage["items"].([]any)
	if !ok || len(items) != 1 {
		t.Fatalf("nested items=%#v, want one item", nestedPage["items"])
	}
	if strings.Contains(string(mustJSON(t, nestedPage)), root) {
		t.Fatal("tree response leaked original media root")
	}
}

func mustJSON(t *testing.T, value any) []byte {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}
