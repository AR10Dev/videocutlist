//go:build realmedia

package realmedia

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
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
	projects := p.request(t, http.MethodGet, "/api/v1/projects")
	projects.Body.Close()
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
	missingAuth := p.requestNoAuth(t, http.MethodPost, "/api/v1/automation")
	if missingAuth.StatusCode != http.StatusUnauthorized {
		missingAuth.Body.Close()
		t.Fatalf("missing automation auth status=%d", missingAuth.StatusCode)
	}
	missingAuth.Body.Close()
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
	malformed := p.requestHeaders(t, http.MethodPost, "/api/v1/automation", strings.NewReader("{"), nil)
	if malformed.StatusCode != http.StatusUnprocessableEntity {
		malformed.Body.Close()
		t.Fatalf("malformed automation status=%d", malformed.StatusCode)
	}
	malformed.Body.Close()
	overlarge := p.requestHeaders(t, http.MethodPost, "/api/v1/automation", strings.NewReader(strings.Repeat("x", 2<<20)), nil)
	if overlarge.StatusCode != http.StatusRequestEntityTooLarge {
		overlarge.Body.Close()
		t.Fatalf("oversized automation status=%d", overlarge.StatusCode)
	}
	overlarge.Body.Close()
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

func TestProductionSymlinkAndSourceChange(t *testing.T) {
	root := t.TempDir()
	p := startProcess(t, root)
	if err := os.Symlink("/etc/passwd", filepath.Join(root, "media", "escape.mp4")); err != nil {
		t.Fatal(err)
	}
	refresh := p.request(t, http.MethodPost, "/api/v1/media/refresh")
	if refresh.StatusCode != http.StatusAccepted {
		refresh.Body.Close()
		t.Fatalf("refresh status=%d", refresh.StatusCode)
	}
	refresh.Body.Close()
	time.Sleep(500 * time.Millisecond)
	var media struct {
		Items []struct {
			ID string `json:"id"`
		} `json:"items"`
	}
	getJSON(t, p, "/api/v1/media", &media)
	if len(media.Items) != 1 {
		t.Fatalf("escaped symlink indexed: %d items", len(media.Items))
	}
	os.Remove(filepath.Join(root, "media", "sintel-trailer.mp4"))
	project := map[string]any{"revision": 0, "schemaVersion": 2, "name": "source change", "items": []any{map[string]any{"id": "i_abcdefghijklmnopqrstuvwx", "mediaId": media.Items[0].ID, "segments": []any{map[string]any{"startMs": 0, "endMs": 1000}}, "exportOptions": map[string]any{"mode": "merge", "selection": "segments", "cutStrategy": "stream_copy_preferred", "container": "mkv", "destinationId": "download"}}}}
	created := p.requestBody(t, http.MethodPut, "/api/v1/projects/p_source_change", project)
	if created.StatusCode != http.StatusOK {
		created.Body.Close()
		t.Fatalf("project status=%d", created.StatusCode)
	}
	created.Body.Close()
	export := p.requestBody(t, http.MethodPost, "/api/v1/projects/p_source_change/exports", map[string]any{"itemIds": []string{"i_abcdefghijklmnopqrstuvwx"}})
	var submitted struct {
		Jobs []struct {
			ID string `json:"id"`
		} `json:"jobs"`
	}
	if export.StatusCode != http.StatusAccepted || json.NewDecoder(export.Body).Decode(&submitted) != nil {
		export.Body.Close()
		t.Fatalf("export status=%d", export.StatusCode)
	}
	export.Body.Close()
	if len(submitted.Jobs) != 1 {
		t.Fatal("source-change export returned no job")
	}
	waitFor(t, 10*time.Second, func() bool {
		response := p.request(t, http.MethodGet, "/api/v1/jobs/"+submitted.Jobs[0].ID)
		defer response.Body.Close()
		var job struct {
			State string `json:"state"`
		}
		if json.NewDecoder(response.Body).Decode(&job) != nil {
			return false
		}
		return job.State == "failed"
	})
	retry := p.request(t, http.MethodPost, "/api/v1/jobs/"+submitted.Jobs[0].ID+"/retry")
	var retried struct {
		BatchID string `json:"batchId"`
	}
	if retry.StatusCode != http.StatusAccepted || json.NewDecoder(retry.Body).Decode(&retried) != nil || retried.BatchID == "" {
		retry.Body.Close()
		t.Fatalf("failed export retry status=%d", retry.StatusCode)
	}
	retry.Body.Close()
}

func TestProductionBatchCancellationLifecycle(t *testing.T) {
	root := t.TempDir()
	p := startProcess(t, root)
	var media struct {
		Items []struct {
			ID string `json:"id"`
		} `json:"items"`
	}
	getJSON(t, p, "/api/v1/media", &media)
	project := map[string]any{"revision": 0, "schemaVersion": 2, "name": "cancel", "items": []any{map[string]any{"id": "i_abcdefghijklmnopqrstuvwx", "mediaId": media.Items[0].ID, "segments": []any{map[string]any{"startMs": 0, "endMs": 52000}}, "exportOptions": map[string]any{"mode": "merge", "selection": "segments", "cutStrategy": "precise_reencode", "container": "mkv", "destinationId": "download"}}}}
	created := p.requestBody(t, http.MethodPut, "/api/v1/projects/p_cancel_123456", project)
	created.Body.Close()
	submit := func() string {
		response := p.requestBody(t, http.MethodPost, "/api/v1/projects/p_cancel_123456/exports", map[string]any{"itemIds": []string{"i_abcdefghijklmnopqrstuvwx"}})
		defer response.Body.Close()
		var value struct {
			BatchID string `json:"batchId"`
		}
		if response.StatusCode != http.StatusAccepted || json.NewDecoder(response.Body).Decode(&value) != nil {
			t.Fatalf("cancel export status=%d", response.StatusCode)
		}
		return value.BatchID
	}
	first, second := submit(), submit()
	cancel := p.request(t, http.MethodDelete, "/api/v1/batches/"+second)
	if cancel.StatusCode != http.StatusNoContent && cancel.StatusCode != http.StatusNotFound {
		cancel.Body.Close()
		t.Fatalf("batch cancellation status=%d", cancel.StatusCode)
	}
	cancel.Body.Close()
	waitFor(t, 10*time.Second, func() bool {
		response := p.request(t, http.MethodGet, "/api/v1/batches/"+second)
		defer response.Body.Close()
		var value struct {
			State string `json:"state"`
		}
		if json.NewDecoder(response.Body).Decode(&value) != nil {
			return false
		}
		return value.State == "cancelled" || value.State == "succeeded"
	})
	repeat := p.request(t, http.MethodDelete, "/api/v1/batches/"+second)
	if repeat.StatusCode != http.StatusNoContent && repeat.StatusCode != http.StatusNotFound {
		repeat.Body.Close()
		t.Fatalf("terminal batch cancellation status=%d", repeat.StatusCode)
	}
	repeat.Body.Close()
	_ = first
}

func TestProductionRestartReconcilesExport(t *testing.T) {
	root := t.TempDir()
	p := startProcess(t, root)
	var media struct {
		Items []struct {
			ID string `json:"id"`
		} `json:"items"`
	}
	getJSON(t, p, "/api/v1/media", &media)
	project := map[string]any{"revision": 0, "schemaVersion": 2, "name": "restart", "items": []any{map[string]any{"id": "i_abcdefghijklmnopqrstuvwx", "mediaId": media.Items[0].ID, "segments": []any{map[string]any{"startMs": 0, "endMs": 52000}}, "exportOptions": map[string]any{"mode": "merge", "selection": "segments", "cutStrategy": "precise_reencode", "container": "mkv", "destinationId": "download"}}}}
	created := p.requestBody(t, http.MethodPut, "/api/v1/projects/p_restart_reconcile", project)
	created.Body.Close()
	export := p.requestBody(t, http.MethodPost, "/api/v1/projects/p_restart_reconcile/exports", map[string]any{"itemIds": []string{"i_abcdefghijklmnopqrstuvwx"}})
	var submitted struct {
		Jobs []struct {
			ID string `json:"id"`
		} `json:"jobs"`
	}
	if json.NewDecoder(export.Body).Decode(&submitted) != nil || len(submitted.Jobs) != 1 {
		export.Body.Close()
		t.Fatal("restart export submission failed")
	}
	export.Body.Close()
	p.stop()
	p = startProcess(t, root)
	getJSON(t, p, "/api/v1/projects/p_restart_reconcile", &map[string]any{})
	waitFor(t, 10*time.Second, func() bool {
		response := p.request(t, http.MethodGet, "/api/v1/jobs/"+submitted.Jobs[0].ID)
		defer response.Body.Close()
		var job struct {
			State string `json:"state"`
		}
		if json.NewDecoder(response.Body).Decode(&job) != nil {
			return false
		}
		return job.State == "failed" || job.State == "succeeded"
	})
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
