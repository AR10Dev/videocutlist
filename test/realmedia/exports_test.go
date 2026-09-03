//go:build realmedia

package realmedia

import (
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestProductionExportsJobsAndOutputs(t *testing.T) {
	root := t.TempDir()
	p := startProcess(t, root)

	var media struct {
		Items []struct {
			ID         string `json:"id"`
			DurationMS int64  `json:"durationMs"`
		} `json:"items"`
	}
	waitFor(t, startupWait, func() bool {
		resp := p.request(t, "GET", "/api/v1/media")
		defer resp.Body.Close()
		return resp.StatusCode == 200 && json.NewDecoder(resp.Body).Decode(&media) == nil && len(media.Items) > 0
	})
	item := media.Items[0]
	if item.DurationMS < 2_000 {
		t.Fatalf("fixture duration = %dms", item.DurationMS)
	}
	projectID := "p_real_media_exports"
	projectItem := map[string]any{"id": "i_abcdefghijklmnopqrstuvwx", "mediaId": item.ID, "segments": []any{
		map[string]any{"startMs": 0, "endMs": 2000, "label": "opening"},
		map[string]any{"startMs": 3000, "endMs": 5000, "label": "second"},
	}}
	project := map[string]any{"revision": 0, "schemaVersion": 2, "name": "real-media exports", "items": []any{projectItem}}
	resp := p.requestBody(t, "PUT", "/api/v1/projects/"+projectID, project)
	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		t.Fatalf("create project status=%d body=%s", resp.StatusCode, body)
	}
	resp.Body.Close()
	revision := int64(1)

	export := func(payload map[string]any) []string {
		preflight := p.requestBody(t, "POST", "/api/v1/projects/"+projectID+"/exports/preflight", payload)
		if preflight.StatusCode != 200 {
			body, _ := io.ReadAll(preflight.Body)
			preflight.Body.Close()
			t.Fatalf("preflight status=%d body=%s", preflight.StatusCode, body)
		}
		preflight.Body.Close()
		response := p.requestBody(t, "POST", "/api/v1/projects/"+projectID+"/exports", payload)
		var submitted struct {
			BatchID string `json:"batchId"`
			Jobs    []struct {
				ID string `json:"id"`
			} `json:"jobs"`
		}
		if response.StatusCode != 202 || json.NewDecoder(response.Body).Decode(&submitted) != nil || submitted.BatchID == "" || len(submitted.Jobs) == 0 {
			body, _ := io.ReadAll(response.Body)
			response.Body.Close()
			t.Fatalf("export status=%d body=%s", response.StatusCode, body)
		}
		response.Body.Close()
		return []string{submitted.BatchID, submitted.Jobs[0].ID}
	}
	base := func(mode, selection, strategy string) map[string]any {
		return map[string]any{"mode": mode, "selection": selection, "cutStrategy": strategy, "container": "mkv", "itemIds": []string{"i_abcdefghijklmnopqrstuvwx"}}
	}
	for _, tc := range []struct{ mode, selection, strategy string }{
		{"merge", "segments", "stream_copy_preferred"},
		{"merge", "segments", "precise_reencode"},
		{"merge", "segments", "hybrid_smart_cut"},
		{"separate", "gaps", "stream_copy_preferred"},
	} {
		projectItem["exportOptions"] = map[string]any{"mode": tc.mode, "selection": tc.selection, "cutStrategy": tc.strategy, "container": "mkv", "destinationId": "download", "streamIndexes": []int{0, 1}}
		project["revision"] = revision
		update := p.requestBody(t, "PUT", "/api/v1/projects/"+projectID, project)
		var saved struct {
			Revision int64 `json:"revision"`
		}
		if update.StatusCode != 200 || json.NewDecoder(update.Body).Decode(&saved) != nil {
			update.Body.Close()
			t.Fatalf("update project for %s failed: %d", tc.strategy, update.StatusCode)
		}
		update.Body.Close()
		revision = saved.Revision
		ids := export(base(tc.mode, tc.selection, tc.strategy))
		batchID, jobID := ids[0], ids[1]
		var final map[string]any
		var terminal map[string]any
		last := -1.0
		waitFor(t, 90*time.Second, func() bool {
			batch := p.request(t, "GET", "/api/v1/batches/"+batchID)
			defer batch.Body.Close()
			var value struct {
				State    string           `json:"state"`
				Progress float64          `json:"progress"`
				Jobs     []map[string]any `json:"jobs"`
			}
			if json.NewDecoder(batch.Body).Decode(&value) != nil {
				return false
			}
			if value.Progress < last {
				t.Fatalf("batch progress regressed from %v to %v", last, value.Progress)
			}
			last = value.Progress
			job := p.request(t, "GET", "/api/v1/jobs/"+jobID)
			var current map[string]any
			if json.NewDecoder(job.Body).Decode(&current) != nil {
				job.Body.Close()
				return false
			}
			job.Body.Close()
			state, _ := current["state"].(string)
			if state == "succeeded" || state == "failed" || state == "cancelled" {
				terminal = current
				final = map[string]any{"state": state, "jobs": value.Jobs}
				return true
			}
			return false
		})
		if final["state"] != "succeeded" {
			t.Fatalf("batch %s terminal state = %v jobs=%v detail=%v\n%s", batchID, final["state"], final["jobs"], terminal, boundedLog(p.log.String()))
		}
		job := p.request(t, "GET", "/api/v1/jobs/"+jobID)
		var detail struct {
			State  string `json:"state"`
			Result *struct {
				OutputCount int `json:"outputCount"`
			} `json:"result"`
		}
		if json.NewDecoder(job.Body).Decode(&detail) != nil || detail.State != "succeeded" {
			t.Fatalf("job %s is not successful", jobID)
		}
		job.Body.Close()
		output := p.request(t, "GET", "/api/v1/jobs/"+jobID+"/outputs/0")
		if output.StatusCode != 200 {
			output.Body.Close()
			t.Fatalf("download output status=%d", output.StatusCode)
		}
		path := filepath.Join(root, "probe-"+jobID)
		file, err := os.Create(path)
		if err != nil {
			output.Body.Close()
			t.Fatal(err)
		}
		_, err = io.Copy(file, output.Body)
		output.Body.Close()
		if closeErr := file.Close(); err != nil || closeErr != nil {
			t.Fatalf("save output: %v", err)
		}
		probe := exec.Command("ffprobe", "-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "json", path)
		if data, err := probe.Output(); err != nil || len(data) == 0 {
			t.Fatalf("ffprobe output: %v", err)
		}
		if err := os.Remove(path); err != nil {
			t.Fatal(err)
		}
	}

	invalid := p.request(t, "GET", "/api/v1/jobs/j_invalid-output/outputs/99")
	if invalid.StatusCode != 404 {
		invalid.Body.Close()
		t.Fatalf("invalid output status=%d", invalid.StatusCode)
	}
	invalid.Body.Close()
	cancel := p.request(t, "DELETE", "/api/v1/jobs/"+"j_invalid-output")
	if cancel.StatusCode != 404 {
		cancel.Body.Close()
		t.Fatalf("unknown cancellation status=%d", cancel.StatusCode)
	}
	cancel.Body.Close()
}
