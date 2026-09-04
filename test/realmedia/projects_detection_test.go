//go:build realmedia

package realmedia

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"syscall"
	"testing"
	"time"
)

type realMediaPage struct {
	Items []struct {
		ID, ETag   string
		DurationMS int64 `json:"durationMs"`
	} `json:"items"`
}

type realProject struct {
	ID            string `json:"id"`
	Revision      int64  `json:"revision"`
	SchemaVersion int    `json:"schemaVersion"`
	Name          string `json:"name"`
	Items         []struct {
		ID       string                           `json:"id"`
		MediaID  string                           `json:"mediaId"`
		Segments []struct{ StartMS, EndMS int64 } `json:"segments"`
	} `json:"items"`
}

type realJob struct {
	ID, State, Kind string
	Candidates      []struct {
		ID, MediaID, ProjectID, Source  string
		ProjectRevision, StartMS, EndMS int64
		Confidence                      float64
	} `json:"candidates"`
}

func TestProjectsInterchangeAndDetectionUseProductionProcess(t *testing.T) {
	p := startProcess(t, t.TempDir())
	var media realMediaPage
	p.json(t, http.MethodGet, "/api/v1/media", nil, http.StatusOK, &media)
	if len(media.Items) != 1 || media.Items[0].ID == "" || len(media.Items[0].ID) < 3 {
		t.Fatalf("media did not return one opaque item: %+v", media)
	}
	m := media.Items[0]
	projectID := "p_real-media-project"
	itemID := "i_" + "real-media-item-00000000" // 24-character opaque item ID
	payload := map[string]any{"revision": 0, "schemaVersion": 2, "name": "Real trailer", "items": []any{map[string]any{
		"id": itemID, "mediaId": m.ID, "segments": []any{map[string]any{"startMs": 1000, "endMs": 3000, "label": "opening"}, map[string]any{"startMs": 5000, "endMs": 7000, "label": "second"}},
	}}}
	var project realProject
	p.json(t, http.MethodPut, "/api/v1/projects/"+projectID, payload, http.StatusOK, &project)
	if project.Revision != 1 {
		t.Fatalf("create revision=%d, want 1", project.Revision)
	}
	p.json(t, http.MethodGet, "/api/v1/projects/"+projectID, nil, http.StatusOK, &project)
	p.json(t, http.MethodGet, "/api/v1/projects?limit=1", nil, http.StatusOK, &struct {
		Items []realProject `json:"items"`
	}{})
	stale := payload
	stale["revision"] = 0
	p.json(t, http.MethodPut, "/api/v1/projects/"+projectID, stale, http.StatusConflict, nil)

	for _, format := range []string{"csv", "chapters"} {
		resp := p.raw(t, http.MethodGet, "/api/v1/projects/"+projectID+"/interchange/"+format+"?itemId="+itemID, nil)
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("export %s status=%d", format, resp.StatusCode)
		}
		data, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if len(data) == 0 {
			t.Fatalf("empty %s export", format)
		}
		p.rawJSON(t, http.MethodPost, "/api/v1/projects/"+projectID+"/interchange/"+format+"?itemId="+itemID, data, http.StatusOK, &project)
		if project.Revision < 2 {
			t.Fatalf("%s import did not increment revision: %d", format, project.Revision)
		}
		bad := []byte("start,end,label\n999:00,999:01,bad\n")
		p.json(t, http.MethodPost, "/api/v1/projects/"+projectID+"/interchange/csv?itemId="+itemID, bad, http.StatusUnprocessableEntity, nil)
	}

	for _, kind := range []string{"silence", "black", "scene"} {
		request := map[string]any{"mediaId": m.ID, "projectItemId": itemID, "projectRevision": project.Revision, "kind": kind, "sourceFingerprint": m.ETag, "minDurationMs": 100}
		var job realJob
		p.json(t, http.MethodPost, "/api/v1/projects/"+projectID+"/detections", request, http.StatusAccepted, &job)
		waitFor(t, 45*time.Second, func() bool {
			p.jsonNoFail(t, http.MethodGet, "/api/v1/jobs/"+job.ID, nil, http.StatusOK, &job)
			return job.State == "succeeded"
		})
		for _, candidate := range job.Candidates {
			if candidate.MediaID != m.ID || candidate.ProjectID != projectID || candidate.Source != kind || candidate.ProjectRevision != project.Revision || candidate.StartMS < 0 || candidate.EndMS > m.DurationMS || candidate.StartMS >= candidate.EndMS || candidate.Confidence < 0 || candidate.Confidence > 1 {
				t.Fatalf("invalid %s candidate: %+v", kind, candidate)
			}
		}
	}
	cancelRequest := map[string]any{"mediaId": m.ID, "projectItemId": itemID, "projectRevision": project.Revision, "kind": "scene", "sourceFingerprint": m.ETag, "minDurationMs": 100}
	var cancelled realJob
	p.json(t, http.MethodPost, "/api/v1/projects/"+projectID+"/detections", cancelRequest, http.StatusAccepted, &cancelled)
	waitFor(t, 10*time.Second, func() bool {
		p.jsonNoFail(t, http.MethodGet, "/api/v1/jobs/"+cancelled.ID, nil, http.StatusOK, &cancelled)
		return cancelled.State == "running"
	})
	ffmpegPID := ffmpegDescendant(t, p)
	cancelResponse := p.request(t, http.MethodDelete, "/api/v1/jobs/"+cancelled.ID)
	if cancelResponse.StatusCode != http.StatusNoContent {
		cancelResponse.Body.Close()
		t.Fatalf("detection cancellation status=%d", cancelResponse.StatusCode)
	}
	cancelResponse.Body.Close()
	_ = syscall.Kill(ffmpegPID, syscall.SIGCONT)
	waitPIDExit(t, ffmpegPID)
	waitFor(t, 45*time.Second, func() bool {
		p.jsonNoFail(t, http.MethodGet, "/api/v1/jobs/"+cancelled.ID, nil, http.StatusOK, &cancelled)
		return cancelled.State == "cancelled"
	})
	badDetection := map[string]any{"mediaId": m.ID, "projectItemId": itemID, "projectRevision": project.Revision, "kind": "scene", "sourceFingerprint": "stale"}
	var staleJob realJob
	p.json(t, http.MethodPost, "/api/v1/projects/"+projectID+"/detections", badDetection, http.StatusAccepted, &staleJob)
	waitFor(t, 45*time.Second, func() bool {
		p.jsonNoFail(t, http.MethodGet, "/api/v1/jobs/"+staleJob.ID, nil, http.StatusOK, &staleJob)
		return staleJob.State == "failed"
	})
	var unchanged realProject
	p.json(t, http.MethodGet, "/api/v1/projects/"+projectID, nil, http.StatusOK, &unchanged)
	if unchanged.Revision != project.Revision || len(unchanged.Items) != len(project.Items) {
		t.Fatalf("stale detection mutated project: before revision %d, after %d", project.Revision, unchanged.Revision)
	}
}

func (p *process) raw(t *testing.T, method, path string, body []byte) *http.Response {
	t.Helper()
	req, err := http.NewRequest(method, p.base+path, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+bearerToken)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := p.do(req)
	if err != nil {
		t.Fatalf("%s %s: %v\n%s", method, path, err, boundedLog(p.log.Snapshot()))
	}
	return resp
}
func (p *process) json(t *testing.T, method, path string, value any, status int, out any) {
	t.Helper()
	p.jsonNoFail(t, method, path, value, status, out)
}
func (p *process) rawJSON(t *testing.T, method, path string, body []byte, status int, out any) {
	t.Helper()
	resp := p.raw(t, method, path, body)
	defer resp.Body.Close()
	if resp.StatusCode != status {
		data, _ := io.ReadAll(resp.Body)
		t.Fatalf("%s %s status=%d want=%d: %s", method, path, resp.StatusCode, status, data)
	}
	if out != nil {
		if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
			t.Fatal(err)
		}
	}
}
func (p *process) jsonNoFail(t *testing.T, method, path string, value any, status int, out any) {
	t.Helper()
	var body []byte
	if value != nil {
		var err error
		body, err = json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
	}
	resp := p.raw(t, method, path, body)
	defer resp.Body.Close()
	if resp.StatusCode != status {
		data, _ := io.ReadAll(resp.Body)
		t.Fatalf("%s %s status=%d want=%d: %s", method, path, resp.StatusCode, status, data)
	}
	if out != nil && resp.StatusCode == http.StatusOK || out != nil && resp.StatusCode == http.StatusAccepted {
		if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
			t.Fatal(err)
		}
	}
}
