//go:build realmedia

package realmedia

import (
	"encoding/json"
	"net/http"
	"testing"
)

func TestProductionSettingsAndAutomationWorkflows(t *testing.T) {
	root := t.TempDir()
	p := startProcess(t, root)
	var settings struct {
		Settings map[string]any `json:"settings"`
		Revision int64          `json:"revision"`
	}
	getJSON(t, p, "/api/v1/settings", &settings)
	if settings.Revision < 1 {
		t.Fatal("settings revision was not initialized")
	}
	settings.Settings["previewGlobalLimit"] = 2
	resp := p.requestBody(t, http.MethodPut, "/api/v1/settings", map[string]any{"revision": settings.Revision, "settings": settings.Settings})
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		t.Fatalf("settings update status=%d", resp.StatusCode)
	}
	resp.Body.Close()
	p.stop()
	p = startProcess(t, root)
	var persisted struct {
		Settings map[string]any `json:"settings"`
	}
	getJSON(t, p, "/api/v1/settings", &persisted)
	if value, ok := persisted.Settings["previewGlobalLimit"].(float64); !ok || value != 2 {
		t.Fatalf("settings did not persist after restart: %#v", persisted.Settings)
	}
	stale := p.requestBody(t, http.MethodPut, "/api/v1/settings", map[string]any{"revision": settings.Revision, "settings": settings.Settings})
	if stale.StatusCode != http.StatusConflict {
		stale.Body.Close()
		t.Fatalf("stale settings status=%d", stale.StatusCode)
	}
	stale.Body.Close()
	deployment := p.requestBody(t, http.MethodPut, "/api/v1/settings", map[string]any{"revision": settings.Revision + 1, "settings": map[string]any{"mediaRoots": map[string]string{"escape": "/tmp"}}})
	if deployment.StatusCode != http.StatusUnprocessableEntity {
		deployment.Body.Close()
		t.Fatalf("deployment settings status=%d", deployment.StatusCode)
	}
	deployment.Body.Close()

	var media struct {
		Items []struct {
			ID string `json:"id"`
		} `json:"items"`
	}
	getJSON(t, p, "/api/v1/media", &media)
	if len(media.Items) != 1 {
		t.Fatalf("media items=%d", len(media.Items))
	}
	project := map[string]any{"revision": 0, "schemaVersion": 2, "name": "automation", "items": []any{map[string]any{"id": "i_abcdefghijklmnopqrstuvwx", "mediaId": media.Items[0].ID, "segments": []any{map[string]any{"startMs": 0, "endMs": 1000}}}}}
	created := p.requestBody(t, http.MethodPut, "/api/v1/projects/p_real_automation", project)
	if created.StatusCode != http.StatusOK {
		created.Body.Close()
		t.Fatalf("project status=%d", created.StatusCode)
	}
	created.Body.Close()
	command := func(payload map[string]any) *http.Response {
		return p.requestBody(t, http.MethodPost, "/api/v1/automation", payload)
	}
	exported := command(map[string]any{"action": "project.export", "projectId": "p_real_automation", "format": "csv"})
	var exportBody struct {
		Content string `json:"content"`
	}
	if exported.StatusCode != http.StatusOK || json.NewDecoder(exported.Body).Decode(&exportBody) != nil || exportBody.Content == "" {
		exported.Body.Close()
		t.Fatalf("automation export status=%d", exported.StatusCode)
	}
	exported.Body.Close()
	imported := command(map[string]any{"action": "project.import", "projectId": "p_real_automation", "format": "csv", "input": exportBody.Content})
	if imported.StatusCode != http.StatusOK {
		imported.Body.Close()
		t.Fatalf("automation import status=%d", imported.StatusCode)
	}
	imported.Body.Close()
	unknown := command(map[string]any{"action": "job.status", "jobId": "j_aaaaaaaaaaaa"})
	if unknown.StatusCode != http.StatusNotFound {
		unknown.Body.Close()
		t.Fatalf("automation status lookup=%d", unknown.StatusCode)
	}
	unknown.Body.Close()
	for _, bad := range []map[string]any{{"action": "filesystem.read"}, {"action": "project.export", "projectId": "p_real_automation", "format": "csv", "extra": true}} {
		rejected := command(bad)
		if rejected.StatusCode < 400 || rejected.StatusCode >= 500 {
			rejected.Body.Close()
			t.Fatalf("automation rejection status=%d", rejected.StatusCode)
		}
		rejected.Body.Close()
	}
}

func TestProductionCORSAndTrustedProxy(t *testing.T) {
	p := startProcessWithEnv(t, t.TempDir(), map[string]string{"VIDEOCUTLIST_ALLOWED_ORIGINS": "https://allowed.example", "VIDEOCUTLIST_TRUSTED_PROXY_CIDRS": "127.0.0.1/32"})
	allowed := p.requestHeaders(t, http.MethodOptions, "/api/v1/media", nil, map[string]string{"Origin": "https://allowed.example", "Access-Control-Request-Method": "GET"})
	if allowed.StatusCode != http.StatusNoContent || allowed.Header.Get("Access-Control-Allow-Origin") != "https://allowed.example" {
		allowed.Body.Close()
		t.Fatalf("allowed CORS status=%d origin=%q", allowed.StatusCode, allowed.Header.Get("Access-Control-Allow-Origin"))
	}
	allowed.Body.Close()
	disallowed := p.requestHeaders(t, http.MethodOptions, "/api/v1/media", nil, map[string]string{"Origin": "https://evil.example", "Access-Control-Request-Method": "GET"})
	if disallowed.StatusCode == http.StatusNoContent {
		disallowed.Body.Close()
		t.Fatal("disallowed CORS preflight succeeded")
	}
	disallowed.Body.Close()
	forwarded := p.requestHeaders(t, http.MethodGet, "/api/v1/ready", nil, map[string]string{"X-Forwarded-For": "203.0.113.9"})
	if forwarded.StatusCode != http.StatusOK || forwarded.Header.Get("X-Forwarded-For") != "" {
		forwarded.Body.Close()
		t.Fatalf("trusted proxy request status=%d", forwarded.StatusCode)
	}
	forwarded.Body.Close()
}

func TestProductionAuthNoneLoopback(t *testing.T) {
	p := startProcessWithEnv(t, t.TempDir(), map[string]string{"VIDEOCUTLIST_AUTH_MODE": "none"})
	resp := p.request(t, http.MethodGet, "/api/v1/ready")
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		t.Fatalf("auth-none readiness=%d", resp.StatusCode)
	}
	resp.Body.Close()
}
