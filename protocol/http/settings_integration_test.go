package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"videocutlist/infrastructure/store"
)

func TestPutSettingsRuntimeFailureDoesNotPersist(t *testing.T) {
	ctx := context.Background()
	db, err := store.OpenDatabase(ctx, t.TempDir()+"/settings.db")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	settings, err := store.NewRuntimeSettingsStore(db)
	if err != nil {
		t.Fatal(err)
	}
	previous, err := settings.Seed(ctx, testRuntimeSettings())
	if err != nil {
		t.Fatal(err)
	}
	candidate := testRuntimeSettings()
	candidate.ExportLimit = 9
	applyErr := errors.New("preview unavailable")
	authenticator, err := NewAuthenticator(AuthConfig{Mode: "none"})
	if err != nil {
		t.Fatal(err)
	}
	server, err := New(Config{
		Authenticator: authenticator, Media: &routeTestMedia{}, Preview: routeTestPreview{},
		Projects: routeTestProjects{}, Exports: routeTestExports{}, Jobs: &routeTestJobs{},
		Settings: settings, RuntimeSettings: store.NewRuntimeSettingsState(previous.Settings),
		ApplyRuntimeSettings: func(store.RuntimeSettings) error { return applyErr },
	})
	if err != nil {
		t.Fatal(err)
	}
	response := putSettingsRequest(t, server, previous.Revision, candidate)
	if response.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	got, err := settings.Get(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if got.Revision != previous.Revision || got.Settings.ExportLimit != previous.Settings.ExportLimit {
		t.Fatalf("persisted settings changed: got=%#v previous=%#v", got, previous)
	}
}

func TestPutSettingsRejectsDeploymentMutation(t *testing.T) {
	ctx := context.Background()
	db, err := store.OpenDatabase(ctx, t.TempDir()+"/settings.db")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	settings, err := store.NewRuntimeSettingsStore(db)
	if err != nil {
		t.Fatal(err)
	}
	previous, err := settings.Seed(ctx, testRuntimeSettings())
	if err != nil {
		t.Fatal(err)
	}
	candidate := testRuntimeSettings()
	candidate.MediaRoots["camera"] = "/attacker"
	applied := false
	authenticator, err := NewAuthenticator(AuthConfig{Mode: "none"})
	if err != nil {
		t.Fatal(err)
	}
	server, err := New(Config{
		Authenticator: authenticator, Media: &routeTestMedia{}, Preview: routeTestPreview{},
		Projects: routeTestProjects{}, Exports: routeTestExports{}, Jobs: &routeTestJobs{}, Settings: settings,
		ApplyRuntimeSettings: func(store.RuntimeSettings) error { applied = true; return nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	response := putSettingsRequest(t, server, previous.Revision, candidate)
	if response.Code != http.StatusUnprocessableEntity || applied {
		t.Fatalf("status=%d applied=%v body=%s", response.Code, applied, response.Body.String())
	}
	got, err := settings.Get(ctx)
	if err != nil || got.Settings.MediaRoots["camera"] != "/media/camera" {
		t.Fatalf("deployment settings changed: got=%#v err=%v", got, err)
	}
	candidate = testRuntimeSettings()
	candidate.Destinations[0].Root = "/attacker"
	response = putSettingsRequest(t, server, previous.Revision, candidate)
	if response.Code != http.StatusUnprocessableEntity || applied {
		t.Fatalf("destination status=%d applied=%v body=%s", response.Code, applied, response.Body.String())
	}
}

func TestPutSettingsPersistenceFailureRestoresRuntime(t *testing.T) {
	ctx := context.Background()
	db, err := store.OpenDatabase(ctx, t.TempDir()+"/settings.db")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	settings, err := store.NewRuntimeSettingsStore(db)
	if err != nil {
		t.Fatal(err)
	}
	previous, err := settings.Seed(ctx, testRuntimeSettings())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `CREATE TRIGGER reject_settings_update BEFORE UPDATE ON runtime_settings BEGIN SELECT RAISE(ABORT, 'injected update failure'); END`); err != nil {
		t.Fatal(err)
	}
	candidate := testRuntimeSettings()
	candidate.ExportLimit = 9
	var applied []store.RuntimeSettings
	authenticator, err := NewAuthenticator(AuthConfig{Mode: "none"})
	if err != nil {
		t.Fatal(err)
	}
	server, err := New(Config{
		Authenticator: authenticator, Media: &routeTestMedia{}, Preview: routeTestPreview{},
		Projects: routeTestProjects{}, Exports: routeTestExports{}, Jobs: &routeTestJobs{},
		Settings: settings, RuntimeSettings: store.NewRuntimeSettingsState(previous.Settings),
		ApplyRuntimeSettings: func(value store.RuntimeSettings) error {
			applied = append(applied, value)
			return nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	response := putSettingsRequest(t, server, previous.Revision, candidate)
	if response.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if len(applied) != 2 || applied[0].ExportLimit != candidate.ExportLimit || applied[1].ExportLimit != previous.Settings.ExportLimit {
		t.Fatalf("runtime apply sequence=%#v", applied)
	}
	got, err := settings.Get(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if got.Revision != previous.Revision || got.Settings.ExportLimit != previous.Settings.ExportLimit {
		t.Fatalf("persisted settings changed: got=%#v previous=%#v", got, previous)
	}
}

func putSettingsRequest(t *testing.T, server http.Handler, revision int64, settings store.RuntimeSettings) *httptest.ResponseRecorder {
	t.Helper()
	body, err := json.Marshal(settingsUpdateRequest{Revision: revision, Settings: settings})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPut, "/api/v1/settings", strings.NewReader(string(body)))
	response := httptest.NewRecorder()
	server.ServeHTTP(response, request)
	return response
}

func testRuntimeSettings() store.RuntimeSettings {
	return store.RuntimeSettings{
		MediaRoots:   map[string]string{"camera": "/media/camera"},
		Destinations: []store.RuntimeDestination{{ID: "download", Label: "Downloads", Kind: "download", Root: "/exports", Retention: "24h"}},
		ExportLimit:  1, CacheMaxBytes: 1024, PreviewGlobalLimit: 2,
		PreviewBeforeMS: 2000, PreviewAfterMS: 6000, PreviewMaxMS: 15000, PreviewGridMS: 500,
		MediaMaxFiles: 100, MediaMaxDepth: 5,
	}
}
