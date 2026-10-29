//go:build realmedia

package realmedia

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestProductionProcessMediaAndDerivedAssets(t *testing.T) {
	root := t.TempDir()
	p := startProcess(t, root)
	var status struct {
		State string `json:"state"`
	}
	getJSON(t, p, "/api/v2/media/status", &status)
	if status.State != "ready_with_media" {
		t.Fatalf("media state=%q", status.State)
	}
	var page struct {
		Items []struct {
			ID string `json:"id"`
		} `json:"items"`
	}
	getJSON(t, p, "/api/v2/media?limit=10", &page)
	if len(page.Items) != 1 || page.Items[0].ID == "" || strings.Contains(page.Items[0].ID, "/") {
		t.Fatalf("unexpected media page: %#v", page)
	}
	mediaID := page.Items[0].ID

	var capabilities struct {
		Strategies []struct {
			Strategy  string `json:"strategy"`
			Supported bool   `json:"supported"`
		} `json:"strategies"`
	}
	getJSON(t, p, "/api/v2/export-capabilities/media/"+mediaID, &capabilities)
	if len(capabilities.Strategies) == 0 || capabilities.Strategies[0].Strategy == "" {
		t.Fatalf("export capabilities missing strategies: %#v", capabilities)
	}

	importResponse := p.requestCommand(t, http.MethodPost, "/api/v2/projects/import", map[string]string{"content": `{"schemaVersion":2,"name":"Real-media import","items":[{"id":"i_aaaaaaaaaaaaaaaaaaaaaaaa","mediaId":"` + mediaID + `","segments":[{"startMs":0,"endMs":1000}]}]}`})
	var imported struct {
		MediaID  string `json:"mediaId"`
		Document struct {
			Name string `json:"name"`
		} `json:"document"`
	}
	if importResponse.StatusCode != http.StatusOK || json.NewDecoder(importResponse.Body).Decode(&imported) != nil || imported.Document.Name != "Real-media import" {
		body, _ := io.ReadAll(importResponse.Body)
		importResponse.Body.Close()
		t.Fatalf("POST project import status=%d body=%s response=%#v", importResponse.StatusCode, body, imported)
	}
	importResponse.Body.Close()

	var detail struct {
		ID         string         `json:"id"`
		DurationMS int64          `json:"durationMs"`
		SizeBytes  int64          `json:"sizeBytes"`
		Container  string         `json:"container"`
		Streams    map[string]any `json:"streams"`
	}
	getJSON(t, p, "/api/v2/media/"+mediaID, &detail)
	if detail.ID != mediaID || detail.DurationMS < 52000 || detail.DurationMS > 53000 || detail.SizeBytes != 4372373 || detail.Container == "" || detail.Streams["video"] == nil || detail.Streams["audio"] == nil {
		t.Fatalf("unexpected media detail: %#v", detail)
	}
	resp := p.request(t, http.MethodGet, "/api/v2/media/tree")
	var tree struct {
		Folders []any `json:"folders"`
		Items   []struct {
			ID string `json:"id"`
		} `json:"items"`
	}
	if resp.StatusCode != http.StatusOK || json.NewDecoder(resp.Body).Decode(&tree) != nil || len(tree.Items) == 0 || tree.Items[0].ID != mediaID {
		resp.Body.Close()
		t.Fatalf("media tree missing root or opaque item status=%d", resp.StatusCode)
	}
	resp.Body.Close()
	previewPath := "/media/v2/media/" + mediaID + "/preview?centerMs=26000&beforeMs=1000&afterMs=1000"
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
	cancelContext, cancelRequest := context.WithCancel(context.Background())
	cancelledRequest, err := http.NewRequestWithContext(cancelContext, http.MethodGet, p.base+"/media/v2/media/"+mediaID+"/preview?centerMs=12000&beforeMs=7000&afterMs=7000", nil)
	if err != nil {
		t.Fatal(err)
	}
	cancelledRequest.Header.Set("Authorization", "Bearer "+bearerToken)
	initialCacheFiles := cacheTempFiles(root)
	responseDone := make(chan *http.Response, 1)
	go func() { response, _ := p.do(cancelledRequest); responseDone <- response }()
	ffmpegPID := ffmpegDescendant(t, p)
	started := false
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if response := cacheTempFiles(root); len(response) > len(initialCacheFiles) {
			started = true
			break
		}
		select {
		case response := <-responseDone:
			if response != nil {
				response.Body.Close()
			}
			t.Fatal("preview request completed before cancellation")
		default:
			time.Sleep(25 * time.Millisecond)
		}
	}
	if !started {
		t.Fatal("preview request did not publish an in-flight cache artifact before deadline")
	}
	cancelRequest()
	_ = syscall.Kill(ffmpegPID, syscall.SIGCONT)
	select {
	case response := <-responseDone:
		if response != nil {
			response.Body.Close()
		}
	case <-time.After(5 * time.Second):
		t.Fatal("cancelled preview request did not stop")
	}
	assertNoTemporaryArtifacts(t, root)
	waitPIDExit(t, ffmpegPID)
	resp = p.request(t, http.MethodGet, previewPath)
	if resp.StatusCode != http.StatusOK || resp.Header.Get("X-Preview-Cache") != "hit" {
		resp.Body.Close()
		t.Fatalf("preview hit status=%d cache=%q", resp.StatusCode, resp.Header.Get("X-Preview-Cache"))
	}
	resp.Body.Close()

	thumbPath := "/media/v2/media/" + mediaID + "/thumbnails?startMs=26000&durationMs=1000&count=1&width=80"
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
	conditional := p.requestHeaders(t, http.MethodGet, thumbPath, nil, map[string]string{"If-None-Match": etag})
	if conditional.StatusCode != http.StatusNotModified {
		conditional.Body.Close()
		t.Fatalf("thumbnail conditional status=%d", conditional.StatusCode)
	}
	conditional.Body.Close()

	wavePath := "/media/v2/media/" + mediaID + "/waveform?startMs=26000&durationMs=1000&samples=64"
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
	suiteSummary.Add("preview=miss,hit thumbnails=generated,conditional waveform=generated")
}

func cacheTempFiles(root string) []string {
	var files []string
	_ = filepath.Walk(filepath.Join(root, "cache"), func(path string, info os.FileInfo, err error) error {
		if err == nil && info != nil && !info.IsDir() {
			files = append(files, path)
		}
		return nil
	})
	return files
}

func TestProductionProcessSecurityBoundaries(t *testing.T) {
	root := t.TempDir()
	p := startProcess(t, root)
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
		resp, err := p.do(req)
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
	if status, _ := request(http.MethodGet, "/api/v2/media", "", nil); status != http.StatusUnauthorized {
		t.Fatalf("missing bearer status=%d", status)
	}
	if status, _ := request(http.MethodGet, "/api/v2/media", "wrong", nil); status != http.StatusUnauthorized {
		t.Fatalf("bad bearer status=%d", status)
	}
	for _, path := range []string{"/api/v2/not-a-route", "/api/v2/media?unexpected=true", "/api/v2/media/m_bad"} {
		if status, body := request(http.MethodGet, path, bearerToken, nil); status < 400 || status >= 500 || strings.Contains(body, root) {
			t.Fatalf("unsafe request %s status=%d body=%s", path, status, body)
		}
	}
	if status, body := request(http.MethodPost, "/api/v2/automation", bearerToken, map[string]string{"Origin": "https://untrusted.example"}); status != http.StatusForbidden || strings.Contains(body, root) {
		t.Fatalf("automation origin status=%d body=%s", status, body)
	}
	if status, body := request(http.MethodGet, "/metrics", "", nil); status != http.StatusUnauthorized || strings.Contains(body, "http_requests_total") {
		t.Fatalf("unauthenticated metrics status=%d body=%s", status, body)
	}
	metrics := p.request(t, http.MethodGet, "/metrics")
	metricsBody, metricsErr := io.ReadAll(metrics.Body)
	contentType := metrics.Header.Get("Content-Type")
	metrics.Body.Close()
	body := string(metricsBody)
	if metricsErr != nil || metrics.StatusCode != http.StatusOK || !strings.Contains(contentType, "text/plain") || !strings.Contains(body, "http_requests_total{") || !strings.Contains(body, "export_jobs_total") || strings.Contains(body, root) || strings.Contains(body, "m_") {
		t.Fatalf("metrics contract status=%d content-type=%q body=%s", metrics.StatusCode, contentType, body)
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
