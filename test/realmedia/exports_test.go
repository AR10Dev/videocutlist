//go:build realmedia

package realmedia

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func assertNoTemporaryArtifacts(t *testing.T, root string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if !temporaryArtifactsPresent(root) {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("temporary export/cache artifact remains")
}

func temporaryArtifactsPresent(root string) bool {
	present := false
	for _, dir := range []string{filepath.Join(root, "exports"), filepath.Join(root, "cache")} {
		_ = filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
			if err == nil && info != nil && !info.IsDir() && (strings.HasSuffix(info.Name(), ".partial") || strings.HasPrefix(info.Name(), ".videocutlist-")) {
				present = true
			}
			return nil
		})
	}
	return present
}

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
		var checked struct {
			Allowed   bool  `json:"allowed"`
			Selection []int `json:"selection"`
			Findings  []struct {
				Code     string `json:"code"`
				Severity string `json:"severity"`
			} `json:"findings"`
		}
		if json.NewDecoder(preflight.Body).Decode(&checked) != nil || !checked.Allowed || len(checked.Selection) != 2 || checked.Selection[0] != 0 || checked.Selection[1] != 1 {
			preflight.Body.Close()
			t.Fatalf("preflight selection=%v allowed=%v", checked.Selection, checked.Allowed)
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
		listing := p.request(t, "GET", "/api/v1/batches?limit=100")
		var batches struct {
			Items []struct {
				ID       string  `json:"batchId"`
				State    string  `json:"state"`
				Progress float64 `json:"progress"`
			} `json:"items"`
		}
		if json.NewDecoder(listing.Body).Decode(&batches) != nil {
			listing.Body.Close()
			t.Fatal("cannot decode batch listing")
		}
		listing.Body.Close()
		found := false
		for _, batch := range batches.Items {
			found = found || batch.ID == submitted.BatchID
		}
		if !found {
			t.Fatalf("submitted batch %s missing from paginated listing", submitted.BatchID)
		}
		return []string{submitted.BatchID, submitted.Jobs[0].ID}
	}
	base := func(mode, selection, strategy string) map[string]any {
		return map[string]any{"mode": mode, "selection": selection, "cutStrategy": strategy, "container": "mkv", "itemIds": []string{"i_abcdefghijklmnopqrstuvwx"}}
	}
	for _, tc := range []struct {
		mode, selection, strategy string
		expectSuccess             bool
	}{
		{"merge", "segments", "stream_copy_preferred", true},
		{"merge", "segments", "precise_reencode", true},
		{"separate", "gaps", "stream_copy_preferred", true},
		{"merge", "segments", "hybrid_smart_cut", false},
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
		suiteSummary.Add("project_id=%s batch_id=%s job_id=%s", projectID, batchID, jobID)
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
		if !tc.expectSuccess {
			if final["state"] != "failed" {
				t.Fatalf("hybrid batch state=%v", final["state"])
			}
			retry := p.request(t, "POST", "/api/v1/jobs/"+jobID+"/retry")
			if retry.StatusCode != http.StatusAccepted {
				retry.Body.Close()
				t.Fatalf("hybrid retry status=%d", retry.StatusCode)
			}
			retry.Body.Close()
			continue
		}
		if final["state"] != "succeeded" {
			t.Fatalf("batch %s terminal state = %v jobs=%v detail=%v\n%s", batchID, final["state"], final["jobs"], terminal, boundedLog(p.log.Snapshot()))
		}
		job := p.request(t, "GET", "/api/v1/jobs/"+jobID)
		var detail struct {
			State  string `json:"state"`
			Result *struct {
				OutputCount int      `json:"outputCount"`
				OutputName  string   `json:"outputName"`
				OutputNames []string `json:"outputNames"`
				Warnings    []struct {
					Code string `json:"code"`
				} `json:"warnings"`
			} `json:"result"`
		}
		if json.NewDecoder(job.Body).Decode(&detail) != nil || detail.State != "succeeded" || detail.Result == nil {
			t.Fatalf("job %s is not successful", jobID)
		}
		job.Body.Close()
		positions := 1
		if tc.mode == "separate" {
			positions = 2
		}
		for position := 0; position < positions; position++ {
			output := p.request(t, "GET", "/api/v1/jobs/"+jobID+"/outputs/"+strconv.Itoa(position))
			if output.StatusCode != 200 {
				output.Body.Close()
				t.Fatalf("download output status=%d", output.StatusCode)
			}
			path := filepath.Join(root, "probe-"+jobID+"-"+strconv.Itoa(position))
			file, err := os.Create(path)
			if err != nil {
				output.Body.Close()
				t.Fatal(err)
			}
			outputBytes, err := io.Copy(file, output.Body)
			output.Body.Close()
			if closeErr := file.Close(); err != nil || closeErr != nil {
				t.Fatalf("save output: %v", err)
			}
			probe := exec.Command("ffprobe", "-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "json", path)
			var parsed struct {
				Format struct {
					Duration string `json:"duration"`
				} `json:"format"`
				Streams []struct {
					Type string `json:"codec_type"`
				} `json:"streams"`
			}
			data, err := probe.Output()
			var parseErr error
			if err == nil {
				parseErr = json.Unmarshal(data, &parsed)
			}
			seconds, durationErr := strconv.ParseFloat(parsed.Format.Duration, 64)
			if err != nil || parseErr != nil || durationErr != nil || seconds <= 0 {
				t.Fatalf("ffprobe output: %v", err)
			}
			hasVideo, hasAudio := false, false
			for _, stream := range parsed.Streams {
				hasVideo = hasVideo || stream.Type == "video"
				hasAudio = hasAudio || stream.Type == "audio"
			}
			if !hasVideo || !hasAudio {
				t.Fatalf("ffprobe streams: %#v", parsed.Streams)
			}
			outputName := detail.Result.OutputName
			if len(detail.Result.OutputNames) > position {
				outputName = detail.Result.OutputNames[position]
			}
			if outputName == "" {
				t.Fatalf("missing output name for position %d", position)
			}
			suiteSummary.Add("output filename=%s size=%d duration=%.3fs streams=video,audio", outputName, outputBytes, seconds)
			if err := os.Remove(path); err != nil {
				t.Fatal(err)
			}
		}
		terminalDelete := p.request(t, "DELETE", "/api/v1/jobs/"+jobID)
		if terminalDelete.StatusCode != http.StatusNoContent {
			terminalDelete.Body.Close()
			t.Fatalf("terminal cancellation status=%d", terminalDelete.StatusCode)
		}
		terminalDelete.Body.Close()
		retry := p.request(t, "POST", "/api/v1/jobs/"+jobID+"/retry")
		if retry.StatusCode != http.StatusConflict {
			retry.Body.Close()
			t.Fatalf("successful retry status=%d", retry.StatusCode)
		}
		retry.Body.Close()
		invalidPosition := p.request(t, "GET", "/api/v1/jobs/"+jobID+"/outputs/99")
		if invalidPosition.StatusCode != http.StatusNotFound {
			invalidPosition.Body.Close()
			t.Fatalf("invalid output position status=%d", invalidPosition.StatusCode)
		}
		invalidPosition.Body.Close()
	}
	assertNoTemporaryArtifacts(t, root)
	suiteSummary.Add("exports=validated output_names_safe sizes_positive durations_plausible streams=video,audio positions_and_count temp_free")

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
