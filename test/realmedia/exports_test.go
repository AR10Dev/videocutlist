//go:build realmedia

package realmedia

import (
	"bufio"
	"crypto/sha256"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func assertRealStreamSnapshot(t *testing.T, response *http.Response, resourceField, resourceID string) {
	t.Helper()
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK || response.Header.Get("Content-Type") != "text/event-stream" || response.Header.Get("X-Request-ID") == "" {
		body, err := io.ReadAll(response.Body)
		if err != nil {
			t.Fatalf("read error response body: %v", err)
		}
		t.Fatalf("SSE response status=%d content-type=%q request-id=%q body=%s", response.StatusCode, response.Header.Get("Content-Type"), response.Header.Get("X-Request-ID"), body)
	}
	reader := bufio.NewReader(response.Body)
	var event, data string
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			t.Fatalf("read initial SSE frame: %v", err)
		}
		line = strings.TrimSuffix(strings.TrimSuffix(line, "\n"), "\r")
		if line == "" {
			break
		}
		if value, ok := strings.CutPrefix(line, "event: "); ok {
			event = value
		}
		if value, ok := strings.CutPrefix(line, "data: "); ok {
			data = value
		}
	}
	var snapshot map[string]json.RawMessage
	if event != "snapshot" || json.Unmarshal([]byte(data), &snapshot) != nil {
		t.Fatalf("invalid initial SSE snapshot event=%q data=%q", event, data)
	}
	var actual string
	if err := json.Unmarshal(snapshot[resourceField], &actual); err != nil || actual != resourceID {
		t.Fatalf("SSE snapshot %s=%q, want %q (decode error %v)", resourceField, actual, resourceID, err)
	}
}

func assertNoTemporaryArtifacts(t *testing.T, root string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if !temporaryArtifactsPresent(root) {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	var remaining []string
	for _, dir := range []string{filepath.Join(root, "exports"), filepath.Join(root, "cache")} {
		_ = filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
			if err == nil && info != nil && isTemporaryArtifact(info) {
				remaining = append(remaining, strings.TrimPrefix(path, root))
			}
			return nil
		})
	}
	t.Fatalf("temporary export/cache artifacts remain: %v", remaining)
}

func temporaryArtifactsPresent(root string) bool {
	present := false
	for _, dir := range []string{filepath.Join(root, "exports"), filepath.Join(root, "cache")} {
		_ = filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
			if err == nil && info != nil && isTemporaryArtifact(info) {
				present = true
			}
			return nil
		})
	}
	return present
}

func isTemporaryArtifact(info os.FileInfo) bool {
	if info.IsDir() {
		return false
	}
	name := info.Name()
	if name == ".videocutlist-batches.lock" {
		// The shared flock inode persists so all publishers lock the same file.
		return false
	}
	return strings.HasSuffix(name, ".partial") ||
		strings.HasPrefix(name, ".videocutlist-") &&
			!(strings.HasPrefix(name, ".videocutlist-export-") && strings.HasSuffix(name, ".json"))
}

func TestProductionExportsPreserveSource(t *testing.T) {
	root := t.TempDir()
	p := startProcess(t, root)
	var media realMediaPage
	getJSON(t, p, "/api/v2/media", &media)
	if len(media.Items) != 1 {
		t.Fatalf("media items=%d", len(media.Items))
	}
	sourcePath := filepath.Join(root, "media", "sintel-trailer.mp4")
	before, err := os.ReadFile(sourcePath)
	if err != nil {
		t.Fatal(err)
	}
	beforeInfo, err := os.Stat(sourcePath)
	if err != nil {
		t.Fatal(err)
	}
	projectID := "p_real_media_exports"
	itemID := "i_abcdefghijklmnopqrstuvwx"
	project := map[string]any{
		"revision": 0, "schemaVersion": 2, "name": "source preservation",
		"items": []any{map[string]any{
			"id": itemID, "mediaId": media.Items[0].ID,
			"segments": []any{map[string]any{"startMs": 1000, "endMs": 3000}},
			"exportOptions": map[string]any{
				"mode": "merge", "selection": "segments", "cutStrategy": "stream_copy_preferred",
				"container": "mkv", "destinationId": "download",
			},
		}},
	}
	var saved realProject
	p.json(t, http.MethodPut, "/api/v2/projects/"+projectID, project, http.StatusOK, &saved)
	response := p.requestCommand(t, http.MethodPost, "/api/v2/projects/"+projectID+"/exports",
		map[string]any{"itemIds": []string{itemID}, "projectRevision": saved.Revision})
	var submitted struct {
		BatchID string `json:"batchId"`
		Jobs    []struct {
			ID string `json:"id"`
		} `json:"jobs"`
	}
	if response.StatusCode != http.StatusAccepted || json.NewDecoder(response.Body).Decode(&submitted) != nil || len(submitted.Jobs) != 1 || submitted.BatchID == "" {
		response.Body.Close()
		t.Fatalf("export submission status=%d value=%+v", response.StatusCode, submitted)
	}
	response.Body.Close()
	jobID := submitted.Jobs[0].ID
	assertRealStreamSnapshot(t, p.request(t, http.MethodGet, "/api/v2/jobs/"+jobID+"/events"), "id", jobID)
	assertRealStreamSnapshot(t, p.request(t, http.MethodGet, "/api/v2/batches/"+submitted.BatchID+"/events"), "batchId", submitted.BatchID)
	var job struct {
		State          string `json:"state"`
		WarningDetails []struct {
			Code string `json:"code"`
		} `json:"warningDetails"`
	}
	waitFor(t, 30*time.Second, func() bool {
		getJSON(t, p, "/api/v2/jobs/"+jobID, &job)
		if job.State == "failed" || job.State == "cancelled" {
			t.Fatalf("export ended unexpectedly: %s", job.State)
		}
		return job.State == "succeeded"
	})
	if len(job.WarningDetails) != 1 || job.WarningDetails[0].Code != "stream_copy_cut_may_not_be_frame_exact" {
		t.Fatalf("stream-copy warning missing: %+v", job.WarningDetails)
	}
	output := p.request(t, http.MethodGet, "/media/v2/jobs/"+jobID+"/outputs/0")
	data, err := io.ReadAll(output.Body)
	output.Body.Close()
	if output.StatusCode != http.StatusOK || err != nil || len(data) == 0 {
		t.Fatalf("output status=%d bytes=%d err=%v", output.StatusCode, len(data), err)
	}
	probeBytes(t, data, ".mkv")
	after, err := os.ReadFile(sourcePath)
	if err != nil {
		t.Fatal(err)
	}
	afterInfo, err := os.Stat(sourcePath)
	if err != nil {
		t.Fatal(err)
	}
	if sha256.Sum256(after) != sha256.Sum256(before) || afterInfo.Size() != beforeInfo.Size() || !afterInfo.ModTime().Equal(beforeInfo.ModTime()) {
		t.Fatal("export changed the source file")
	}
	assertNoTemporaryArtifacts(t, root)
	suiteSummary.Add("export job_id=%s source_unchanged temp_free", jobID)
}
