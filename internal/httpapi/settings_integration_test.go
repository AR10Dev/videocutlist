package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"videocutlist/internal/db"
	"videocutlist/internal/httpapi/transport"
	settingsdomain "videocutlist/internal/settings"
	settingsmodel "videocutlist/internal/settings/model"
)

func TestPutSettingsRuntimeFailureDoesNotPersist(t *testing.T) {
	ctx := context.Background()
	db, err := store.OpenDatabase(ctx, t.TempDir()+"/settings.db")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Error(err)
		}
	})
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
		Projects: routeTestProjects{}, BatchExports: &routeTestBatchExports{}, Jobs: &routeTestJobs{},
		Settings: settingsdomain.NewRuntimeService(settings, settingsmodel.NewRuntimeSettingsState(previous.Settings), func(context.Context, settingsmodel.RuntimeSettings) error { return applyErr }),
	})
	if err != nil {
		t.Fatal(err)
	}
	response := putSettingsRequest(t, server, previous.Revision, candidate)
	if response.Code != http.StatusInternalServerError {
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

func TestPutSettingsRejectsInvalidDocumentsWithoutToggling(t *testing.T) {
	ctx := t.Context()
	db, err := store.OpenDatabase(ctx, t.TempDir()+"/settings.db")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Error(err)
		}
	})
	settings, err := store.NewRuntimeSettingsStore(db)
	if err != nil {
		t.Fatal(err)
	}
	defaults := testRuntimeSettings()
	defaults.MCPEnabled = true
	previous, err := settings.Seed(ctx, defaults)
	if err != nil {
		t.Fatal(err)
	}
	state := settingsmodel.NewRuntimeSettingsState(previous.Settings)
	authenticator, err := NewAuthenticator(AuthConfig{Mode: "none"})
	if err != nil {
		t.Fatal(err)
	}
	server, err := New(Config{
		Authenticator: authenticator, Media: &routeTestMedia{}, Preview: routeTestPreview{},
		Projects: routeTestProjects{}, BatchExports: &routeTestBatchExports{}, Jobs: &routeTestJobs{},
		Settings: settingsdomain.NewRuntimeService(settings, state, nil),
	})
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(settingsUpdateRequest{Revision: previous.Revision, Settings: defaults})
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name   string
		mutate func(map[string]any)
	}{
		{
			name: "omitted MCP enablement",
			mutate: func(payload map[string]any) {
				delete(payload["settings"].(map[string]any), "mcpEnabled")
			},
		},
		{
			name: "explicit null MCP enablement",
			mutate: func(payload map[string]any) {
				payload["settings"].(map[string]any)["mcpEnabled"] = nil
			},
		},
		{
			name: "unknown top-level field",
			mutate: func(payload map[string]any) {
				payload["unexpected"] = true
			},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			var payload map[string]any
			if err := json.Unmarshal(encoded, &payload); err != nil {
				t.Fatal(err)
			}
			test.mutate(payload)
			body, err := json.Marshal(payload)
			if err != nil {
				t.Fatal(err)
			}
			response := putSettingsBodyRequest(t, server, body)
			if response.Code != http.StatusBadRequest {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
			got, err := settings.Get(ctx)
			if err != nil {
				t.Fatal(err)
			}
			live := state.Snapshot()
			if got.Revision != previous.Revision || !got.Settings.MCPEnabled || !live.MCPEnabled {
				t.Fatalf("invalid settings changed state: got=%#v previous=%#v live=%#v", got, previous, live)
			}
		})
	}
}

func TestGetSettingsReturnsCompleteMutableDocument(t *testing.T) {
	ctx := t.Context()
	db, err := store.OpenDatabase(ctx, t.TempDir()+"/settings.db")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Error(err)
		}
	})
	settings, err := store.NewRuntimeSettingsStore(db)
	if err != nil {
		t.Fatal(err)
	}
	runtimeSettings := testRuntimeSettings()
	availableRoot := t.TempDir()
	unavailableRoot := filepath.Join(t.TempDir(), "deployment-missing-root")
	fileRoot := filepath.Join(t.TempDir(), "deployment-file-root")
	if err := os.WriteFile(fileRoot, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	runtimeSettings.MediaRoots = map[string]string{
		"camera": availableRoot, "missing": unavailableRoot, "not_directory": fileRoot,
	}
	if _, err := settings.Seed(ctx, runtimeSettings); err != nil {
		t.Fatal(err)
	}
	authenticator, err := NewAuthenticator(AuthConfig{Mode: "none"})
	if err != nil {
		t.Fatal(err)
	}
	server, err := New(Config{
		Authenticator: authenticator, Media: &routeTestMedia{}, Preview: routeTestPreview{},
		Projects: routeTestProjects{}, BatchExports: &routeTestBatchExports{}, Jobs: &routeTestJobs{},
		Settings: settingsdomain.NewRuntimeService(settings, nil, nil),
	})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodGet, "/api/v2/settings", nil)
	response := httptest.NewRecorder()
	server.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	var payload struct {
		Settings map[string]json.RawMessage `json:"settings"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	var mapped transport.SettingsResponse
	if err := json.Unmarshal(response.Body.Bytes(), &mapped); err != nil {
		t.Fatal(err)
	}
	available := mapped.Roots["camera"]
	if available.State == nil || *available.State != transport.Ready || available.ReasonCode == nil || *available.ReasonCode != "media_root_available" {
		t.Fatalf("available root status=%#v", available)
	}
	if available.Message == nil || *available.Message != "Media root is available to the server." {
		t.Fatalf("available root message=%v", available.Message)
	}
	unavailable := mapped.Roots["missing"]
	if unavailable.State == nil || *unavailable.State != transport.Unavailable || unavailable.ReasonCode == nil || *unavailable.ReasonCode != "media_root_unavailable" {
		t.Fatalf("unavailable root status=%#v", unavailable)
	}
	fallbackMessage := "Media root is not available to the server. Check the deployment mount or directory permissions."
	if unavailable.Message == nil || *unavailable.Message != fallbackMessage {
		t.Fatalf("unavailable root fallback message=%v", unavailable.Message)
	}
	notDirectory := mapped.Roots["not_directory"]
	if notDirectory.State == nil || *notDirectory.State != transport.Unavailable || notDirectory.ReasonCode == nil || *notDirectory.ReasonCode != "media_root_unavailable" {
		t.Fatalf("non-directory root status=%#v", notDirectory)
	}
	body := response.Body.String()
	for _, privateValue := range []string{availableRoot, unavailableRoot, fileRoot, "no such file", "/exports", `"mediaRoots"`} {
		if strings.Contains(body, privateValue) {
			t.Fatalf("GET settings leaked deployment data or filesystem errors: %s", body)
		}
	}
	if mapped.Settings.Destinations == nil || len(*mapped.Settings.Destinations) != 1 || (*mapped.Settings.Destinations)[0].Label != "Downloads" {
		t.Fatalf("GET settings did not preserve safe destination metadata: %#v", mapped.Settings.Destinations)
	}
	for _, field := range []string{
		"destinations", "exportLimit", "cacheMaxBytes", "previewGlobalLimit", "previewBeforeMs",
		"previewAfterMs", "previewMaxMs", "previewGridMs", "mediaMaxFiles", "mediaMaxDepth", "mcpEnabled",
	} {
		if _, ok := payload.Settings[field]; !ok {
			t.Errorf("GET settings omitted %q: %s", field, response.Body.String())
		}
	}
}

func TestPutSettingsRejectsDeploymentMutation(t *testing.T) {
	ctx := context.Background()
	db, err := store.OpenDatabase(ctx, t.TempDir()+"/settings.db")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Error(err)
		}
	})
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
		Projects: routeTestProjects{}, BatchExports: &routeTestBatchExports{}, Jobs: &routeTestJobs{}, Settings: settingsdomain.NewRuntimeService(settings, nil, func(context.Context, settingsmodel.RuntimeSettings) error { applied = true; return nil }),
	})
	if err != nil {
		t.Fatal(err)
	}
	response := putSettingsRequest(t, server, previous.Revision, candidate)
	if response.Code != http.StatusBadRequest || applied {
		t.Fatalf("status=%d applied=%v body=%s", response.Code, applied, response.Body.String())
	}
	got, err := settings.Get(ctx)
	if err != nil || got.Settings.MediaRoots["camera"] != "/media/camera" {
		t.Fatalf("deployment settings changed: got=%#v err=%v", got, err)
	}
	candidate = testRuntimeSettings()
	candidate.Destinations[0].Root = "/attacker"
	response = putSettingsRequest(t, server, previous.Revision, candidate)
	if response.Code != http.StatusBadRequest || applied {
		t.Fatalf("destination status=%d applied=%v body=%s", response.Code, applied, response.Body.String())
	}
}

func TestPutSettingsPersistenceFailureRestoresRuntime(t *testing.T) {
	ctx := context.Background()
	db, err := store.OpenDatabase(ctx, t.TempDir()+"/settings.db")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Error(err)
		}
	})
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
	var applied []settingsmodel.RuntimeSettings
	authenticator, err := NewAuthenticator(AuthConfig{Mode: "none"})
	if err != nil {
		t.Fatal(err)
	}
	server, err := New(Config{
		Authenticator: authenticator, Media: &routeTestMedia{}, Preview: routeTestPreview{},
		Projects: routeTestProjects{}, BatchExports: &routeTestBatchExports{}, Jobs: &routeTestJobs{},
		Settings: settingsdomain.NewRuntimeService(settings, settingsmodel.NewRuntimeSettingsState(previous.Settings), func(_ context.Context, value settingsmodel.RuntimeSettings) error {
			applied = append(applied, value)
			return nil
		}),
	})
	if err != nil {
		t.Fatal(err)
	}
	response := putSettingsRequest(t, server, previous.Revision, candidate)
	if response.Code != http.StatusInternalServerError {
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

func putSettingsRequest(t *testing.T, server http.Handler, revision int64, settings settingsmodel.RuntimeSettings) *httptest.ResponseRecorder {
	t.Helper()
	body, err := json.Marshal(settingsUpdateRequest{Revision: revision, Settings: settings})
	if err != nil {
		t.Fatal(err)
	}
	return putSettingsBodyRequest(t, server, body)
}

func putSettingsBodyRequest(t *testing.T, server http.Handler, body []byte) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodPut, "/api/v2/settings", strings.NewReader(string(body)))
	response := httptest.NewRecorder()
	server.ServeHTTP(response, request)
	return response
}

func testRuntimeSettings() settingsmodel.RuntimeSettings {
	return settingsmodel.RuntimeSettings{
		MediaRoots:   map[string]string{"camera": "/media/camera"},
		Destinations: []settingsmodel.RuntimeDestination{{ID: "download", Label: "Downloads", Kind: "download", Root: "/exports", Retention: "24h"}},
		ExportLimit:  1, CacheMaxBytes: 1024, PreviewGlobalLimit: 2,
		PreviewBeforeMS: 2000, PreviewAfterMS: 6000, PreviewMaxMS: 15000, PreviewGridMS: 500,
		MediaMaxFiles: 100, MediaMaxDepth: 5, MCPEnabled: false,
	}
}
