//go:build realmedia

package realmedia

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestProductionProcessMediaAndDerivedAssets(t *testing.T) {
	p := startProcess(t, t.TempDir())
	for _, path := range []string{"/api/v1/health", "/api/v1/ready", "/", "/api/v1/destinations", "/api/v1/settings", "/api/v1/batches"} {
		resp := p.request(t, http.MethodGet, path)
		if resp.StatusCode != http.StatusOK {
			resp.Body.Close()
			t.Fatalf("GET %s status=%d", path, resp.StatusCode)
		}
		resp.Body.Close()
	}

	var status struct {
		State string `json:"state"`
	}
	getJSON(t, p, "/api/v1/media/status", &status)
	if status.State != "ready_with_media" {
		t.Fatalf("media state=%q", status.State)
	}
	var page struct {
		Items []struct {
			ID string `json:"id"`
		} `json:"items"`
	}
	getJSON(t, p, "/api/v1/media?limit=10", &page)
	if len(page.Items) != 1 || page.Items[0].ID == "" || strings.Contains(page.Items[0].ID, "/") {
		t.Fatalf("unexpected media page: %#v", page)
	}
	mediaID := page.Items[0].ID

	var detail struct {
		ID         string         `json:"id"`
		DurationMS int64          `json:"durationMs"`
		SizeBytes  int64          `json:"sizeBytes"`
		Container  string         `json:"container"`
		Streams    map[string]any `json:"streams"`
	}
	getJSON(t, p, "/api/v1/media/"+mediaID, &detail)
	if detail.ID != mediaID || detail.DurationMS < 52000 || detail.DurationMS > 53000 || detail.SizeBytes != 4372373 || detail.Container == "" || detail.Streams["video"] == nil || detail.Streams["audio"] == nil {
		t.Fatalf("unexpected media detail: %#v", detail)
	}
	for _, path := range []string{"/api/v1/media/tree", "/api/v1/media?limit=1"} {
		resp := p.request(t, http.MethodGet, path)
		if resp.StatusCode != http.StatusOK {
			resp.Body.Close()
			t.Fatalf("GET %s status=%d", path, resp.StatusCode)
		}
		resp.Body.Close()
	}
	for _, path := range []string{"/api/v1/media/refresh", "/api/v1/settings/media/refresh"} {
		resp := p.request(t, http.MethodPost, path)
		if resp.StatusCode != http.StatusAccepted {
			resp.Body.Close()
			t.Fatalf("POST %s status=%d", path, resp.StatusCode)
		}
		resp.Body.Close()
	}
	resp := p.request(t, http.MethodPost, "/api/v1/media/import")
	var importJob struct {
		ID string `json:"id"`
	}
	if resp.StatusCode != http.StatusAccepted || json.NewDecoder(resp.Body).Decode(&importJob) != nil || importJob.ID == "" {
		resp.Body.Close()
		t.Fatalf("POST media import status=%d", resp.StatusCode)
	}
	resp.Body.Close()
	resp = p.request(t, http.MethodGet, "/api/v1/media/import/"+importJob.ID)
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		t.Fatalf("GET media import status=%d", resp.StatusCode)
	}
	resp.Body.Close()
	resp = p.request(t, http.MethodDelete, "/api/v1/media/import/"+importJob.ID)
	if resp.StatusCode != http.StatusNoContent {
		resp.Body.Close()
		t.Fatalf("DELETE media import status=%d", resp.StatusCode)
	}
	resp.Body.Close()

	previewPath := "/api/v1/media/" + mediaID + "/preview?centerMs=26000&beforeMs=1000&afterMs=1000"
	resp = p.request(t, http.MethodHead, previewPath)
	if resp.StatusCode != http.StatusNotFound {
		resp.Body.Close()
		t.Fatalf("preview miss status=%d", resp.StatusCode)
	}
	resp.Body.Close()
	resp = p.request(t, http.MethodGet, previewPath)
	preview, err := io.ReadAll(resp.Body)
	resp.Body.Close()
	if err != nil || resp.StatusCode != http.StatusOK || len(preview) < 1024 || resp.Header.Get("Content-Type") != "video/mp4" || resp.Header.Get("X-Preview-Cache") != "miss" {
		t.Fatalf("preview miss response status=%d bytes=%d cache=%q err=%v", resp.StatusCode, len(preview), resp.Header.Get("X-Preview-Cache"), err)
	}
	probeBytes(t, preview, ".mp4")
	resp = p.request(t, http.MethodGet, previewPath)
	if resp.StatusCode != http.StatusOK || resp.Header.Get("X-Preview-Cache") != "hit" {
		resp.Body.Close()
		t.Fatalf("preview hit status=%d cache=%q", resp.StatusCode, resp.Header.Get("X-Preview-Cache"))
	}
	resp.Body.Close()
	for _, center := range []string{"0", "52000"} {
		resp = p.request(t, http.MethodGet, "/api/v1/media/"+mediaID+"/preview?centerMs="+center+"&beforeMs=1000&afterMs=1000")
		if resp.StatusCode != http.StatusOK {
			resp.Body.Close()
			t.Fatalf("boundary preview center=%s status=%d", center, resp.StatusCode)
		}
		resp.Body.Close()
	}

	thumbPath := "/api/v1/media/" + mediaID + "/thumbnails?startMs=26000&durationMs=1000&count=1&width=80"
	resp = p.request(t, http.MethodGet, thumbPath)
	thumb, err := io.ReadAll(resp.Body)
	resp.Body.Close()
	if err != nil || resp.StatusCode != http.StatusOK || len(thumb) < 8 || !bytes.Equal(thumb[:8], []byte("\x89PNG\r\n\x1a\n")) {
		t.Fatalf("thumbnail status=%d bytes=%d err=%v", resp.StatusCode, len(thumb), err)
	}
	etag := resp.Header.Get("ETag")
	if etag == "" {
		t.Fatal("thumbnail response has no ETag")
	}
	resp = p.requestBody(t, http.MethodGet, thumbPath, nil)
	if resp.StatusCode != http.StatusOK || resp.Header.Get("ETag") != etag {
		resp.Body.Close()
		t.Fatalf("thumbnail repeat status=%d etag=%q", resp.StatusCode, resp.Header.Get("ETag"))
	}
	resp.Body.Close()
	conditional := p.requestHeaders(t, http.MethodGet, thumbPath, nil, map[string]string{"If-None-Match": etag})
	if conditional.StatusCode != http.StatusNotModified {
		conditional.Body.Close()
		t.Fatalf("thumbnail conditional status=%d", conditional.StatusCode)
	}
	conditional.Body.Close()

	wavePath := "/api/v1/media/" + mediaID + "/waveform?startMs=26000&durationMs=1000&samples=64"
	var wave struct {
		StartMS    int64     `json:"startMs"`
		DurationMS int64     `json:"durationMs"`
		Peaks      []float64 `json:"peaks"`
	}
	getJSON(t, p, wavePath, &wave)
	if wave.StartMS != 26000 || wave.DurationMS != 1000 || len(wave.Peaks) != 64 {
		t.Fatalf("unexpected waveform: %#v", wave)
	}
	for _, peak := range wave.Peaks {
		if peak < 0 || peak > 1 {
			t.Fatalf("waveform peak=%v", peak)
		}
	}
	waveResp := p.request(t, http.MethodGet, wavePath)
	waveETag := waveResp.Header.Get("ETag")
	waveResp.Body.Close()
	if waveETag == "" {
		t.Fatal("waveform response has no ETag")
	}
	conditionalWave := p.requestHeaders(t, http.MethodGet, wavePath, nil, map[string]string{"If-None-Match": waveETag})
	if conditionalWave.StatusCode != http.StatusNotModified {
		conditionalWave.Body.Close()
		t.Fatalf("waveform conditional status=%d", conditionalWave.StatusCode)
	}
	conditionalWave.Body.Close()
}

func TestProductionProcessSecurityBoundaries(t *testing.T) {
	root := t.TempDir()
	p := startProcess(t, root)
	client := &http.Client{Timeout: time.Second}
	request := func(method, path, token string, headers map[string]string) (int, string) {
		t.Helper()
		req, err := http.NewRequest(method, p.base+path, nil)
		if err != nil {
			t.Fatal(err)
		}
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		for key, value := range headers {
			req.Header.Set(key, value)
		}
		resp, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		body, err := io.ReadAll(resp.Body)
		if err != nil {
			t.Fatal(err)
		}
		return resp.StatusCode, string(body)
	}
	if status, _ := request(http.MethodGet, "/api/v1/media", "", nil); status != http.StatusUnauthorized {
		t.Fatalf("missing bearer status=%d", status)
	}
	if status, _ := request(http.MethodGet, "/api/v1/media", "wrong", nil); status != http.StatusUnauthorized {
		t.Fatalf("bad bearer status=%d", status)
	}
	for _, path := range []string{"/api/v1/not-a-route", "/api/v1/media?unexpected=true", "/api/v1/media/m_bad"} {
		if status, body := request(http.MethodGet, path, bearerToken, nil); status < 400 || status >= 500 || strings.Contains(body, root) {
			t.Fatalf("unsafe request %s status=%d body=%s", path, status, body)
		}
	}
	if status, body := request(http.MethodPost, "/api/v1/automation", bearerToken, map[string]string{"Origin": "https://untrusted.example"}); status != http.StatusForbidden || strings.Contains(body, root) {
		t.Fatalf("automation origin status=%d body=%s", status, body)
	}
	if status, body := request(http.MethodGet, "/metrics", bearerToken, nil); status != http.StatusOK || strings.Contains(body, root) || strings.Contains(body, "m_") {
		t.Fatalf("metrics redaction status=%d body=%s", status, body)
	}
}

func getJSON(t *testing.T, p *process, path string, target any) {
	t.Helper()
	resp := p.request(t, http.MethodGet, path)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET %s status=%d", path, resp.StatusCode)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("GET %s body: %v", path, err)
	}
	if strings.Contains(string(body), "/tmp/") || strings.Contains(string(body), "videocutlist.db") {
		t.Fatalf("GET %s exposes a filesystem path", path)
	}
	if err := json.Unmarshal(body, target); err != nil {
		t.Fatalf("GET %s JSON: %v", path, err)
	}
}

func probeBytes(t *testing.T, content []byte, suffix string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "asset"+suffix)
	if err := os.WriteFile(path, content, 0o600); err != nil {
		t.Fatal(err)
	}
	if output, err := exec.Command("ffprobe", "-v", "error", "-show_entries", "format=format_name", "-of", "default=nw=1:nk=1", path).CombinedOutput(); err != nil || strings.TrimSpace(string(output)) == "" {
		t.Fatalf("ffprobe asset: %v: %s", err, output)
	}
}
