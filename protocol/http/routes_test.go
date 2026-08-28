package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"videocutlist/application"
	"videocutlist/domain"
	"videocutlist/infrastructure/store"
)

func TestParseRoute(t *testing.T) {
	media := "m_" + strings.Repeat("a", 43)
	project := "p_" + strings.Repeat("b", 12)
	job := "j_" + strings.Repeat("c", 12)
	batch := "b_" + strings.Repeat("d", 12)
	tests := []struct {
		name, method, path string
		kind               routeKind
		id                 string
	}{
		{"list", http.MethodGet, "/api/v1/media", routeListMedia, ""},
		{"browse root", http.MethodGet, "/api/v1/media/tree", routeBrowseMedia, ""},
		{"status", http.MethodGet, "/api/v1/media/status", routeMediaStatus, ""},
		{"refresh", http.MethodPost, "/api/v1/media/refresh", routeRefreshMedia, ""},
		{"settings get", http.MethodGet, "/api/v1/settings", routeGetSettings, ""},
		{"settings put", http.MethodPut, "/api/v1/settings", routePutSettings, ""},
		{"settings refresh", http.MethodPost, "/api/v1/settings/media/refresh", routeRefreshSettings, ""},
		{"media", http.MethodGet, "/api/v1/media/" + media, routeGetMedia, media},
		{"preview head", http.MethodHead, "/api/v1/media/" + media + "/preview", routePreview, media},
		{"thumbnails", http.MethodGet, "/api/v1/media/" + media + "/thumbnails", routeThumbnails, media},
		{"waveform", http.MethodGet, "/api/v1/media/" + media + "/waveform", routeWaveform, media},
		{"project put", http.MethodPut, "/api/v1/projects/" + project, routePutProject, project},
		{"export", http.MethodPost, "/api/v1/projects/" + project + "/exports", routeCreateExport, project},
		{"export preflight", http.MethodPost, "/api/v1/projects/" + project + "/exports/preflight", routePreflightExport, project},
		{"csv import", http.MethodPost, "/api/v1/projects/" + project + "/interchange/csv", routeImportInterchange, project + ":csv"},
		{"chapter export", http.MethodGet, "/api/v1/projects/" + project + "/interchange/chapters", routeExportInterchange, project + ":chapters"},
		{"detection", http.MethodPost, "/api/v1/projects/" + project + "/detections", routeCreateDetection, project},
		{"job delete", http.MethodDelete, "/api/v1/jobs/" + job, routeCancelJob, job},
		{"batch get", http.MethodGet, "/api/v1/batches/" + batch, routeGetBatch, batch},
		{"batch delete", http.MethodDelete, "/api/v1/batches/" + batch, routeCancelBatch, batch},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got := parseRoute(test.method, test.path)
			if got.kind != test.kind || got.id != test.id {
				t.Fatalf("route=%#v, want kind=%d id=%q", got, test.kind, test.id)
			}
		})
	}
}

func TestParseRouteRejectsMalformedIDsAndPaths(t *testing.T) {
	valid := "m_" + strings.Repeat("a", 43)
	for _, path := range []string{
		"/api/v1/media/m_bad",
		"/api/v1/media/" + valid + "/extra",
		"/api/v1/media/../etc/passwd",
		"/api/v1/media/" + valid + "%2Fpreview",
		"/api/v1/media/" + valid + "/preview/extra",
	} {
		if got := parseRoute(http.MethodGet, path); got.kind != routeUnknown {
			t.Errorf("%s: got %#v", path, got)
		}
	}
	if got := parseRoute(http.MethodPost, "/api/v1/media"); got.kind != routeUnknown {
		t.Fatalf("unsupported method got %#v", got)
	}
}

type routeTestMedia struct {
	gets        int
	browses     int
	folderID    string
	cursor      string
	browseLimit int
}

func (m *routeTestMedia) List(context.Context, string, int) (MediaPage, error) {
	return MediaPage{}, nil
}
func (m *routeTestMedia) Browse(_ context.Context, folderID, cursor string, limit int) (FolderPage, error) {
	m.browses++
	m.folderID, m.cursor, m.browseLimit = folderID, cursor, limit
	return FolderPage{Folders: []application.FolderNode{{ID: "f_folder", Label: "Folder"}}}, nil
}
func (m *routeTestMedia) Get(context.Context, string) (Media, error) {
	m.gets++
	return Media{}, nil
}
func (m *routeTestMedia) RefreshMedia(context.Context) error { return nil }
func (m *routeTestMedia) Status() LibraryStatus {
	return LibraryStatus{State: LibraryReadyEmpty, Message: "No supported media was found."}
}

func TestBatchExportEndpointsUseInjectedService(t *testing.T) {
	authenticator, err := NewAuthenticator(AuthConfig{Mode: "none"})
	if err != nil {
		t.Fatal(err)
	}
	batch := &routeTestBatchExports{}
	server, err := New(Config{Authenticator: authenticator, Media: &routeTestMedia{}, Preview: routeTestPreview{}, Projects: routeTestProjects{}, Exports: routeTestExports{}, BatchExports: batch, Jobs: &routeTestJobs{}})
	if err != nil {
		t.Fatal(err)
	}
	project := "p_" + strings.Repeat("a", 12)
	batchID := "b_" + strings.Repeat("a", 12)
	request := httptest.NewRequest(http.MethodPost, "/api/v1/projects/"+project+"/exports", strings.NewReader(`{"itemIds":["i_aaaaaaaaaaaaaaaaaaaaaaaa"]}`))
	recorder := httptest.NewRecorder()
	server.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusAccepted || batch.submits != 1 {
		t.Fatalf("submit status=%d submits=%d body=%s", recorder.Code, batch.submits, recorder.Body.String())
	}
	for _, method := range []string{http.MethodGet, http.MethodDelete} {
		recorder = httptest.NewRecorder()
		server.ServeHTTP(recorder, httptest.NewRequest(method, "/api/v1/batches/"+batchID, nil))
		want := http.StatusOK
		if method == http.MethodDelete {
			want = http.StatusNoContent
		}
		if recorder.Code != want {
			t.Fatalf("%s status=%d want=%d body=%s", method, recorder.Code, want, recorder.Body.String())
		}
	}
	if batch.progress != 1 || batch.cancels != 1 {
		t.Fatalf("batch calls progress=%d cancels=%d", batch.progress, batch.cancels)
	}
}

func TestBrowseMediaDispatchesOpaqueQueryToProductionService(t *testing.T) {
	authenticator, err := NewAuthenticator(AuthConfig{Mode: "none"})
	if err != nil {
		t.Fatal(err)
	}
	media := &routeTestMedia{}
	server, err := New(Config{Authenticator: authenticator, Media: media, Preview: routeTestPreview{}, Projects: routeTestProjects{}, Exports: routeTestExports{}, Jobs: &routeTestJobs{}})
	if err != nil {
		t.Fatal(err)
	}
	folderID := "f_" + strings.Repeat("x", 43)
	cursor := "m_" + strings.Repeat("y", 43)
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/v1/media/tree?folderId="+folderID+"&cursor="+cursor+"&limit=25", nil)
	server.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status=%d, want %d", recorder.Code, http.StatusOK)
	}
	if media.browses != 1 || media.folderID != folderID || media.cursor != cursor || media.browseLimit != 25 {
		t.Fatalf("browse=(%d, %q, %q, %d)", media.browses, media.folderID, media.cursor, media.browseLimit)
	}
	if strings.Contains(recorder.Body.String(), "path") {
		t.Fatalf("browse response leaked a path: %s", recorder.Body.String())
	}
}

type routeTestAssets struct{}

func (routeTestAssets) Thumbnails(context.Context, domain.Principal, AssetSpec) (AssetResult, error) {
	return AssetResult{Reader: io.NopCloser(bytes.NewReader([]byte("png")))}, nil
}
func (routeTestAssets) Waveform(context.Context, domain.Principal, AssetSpec) (AssetResult, error) {
	return AssetResult{StartMS: 0, DurationMS: 1000, Peaks: []float64{0.5}}, nil
}

type routeTestPreview struct{}

func (routeTestPreview) Start(context.Context, domain.Principal, PreviewSpec) (PreviewResult, error) {
	return PreviewResult{}, nil
}
func (routeTestPreview) Cached(context.Context, PreviewSpec) (bool, error) { return false, nil }

type routeTestProjects struct{}

func (routeTestProjects) Create(context.Context, string, application.ProjectInput) (Project, error) {
	return Project{}, nil
}
func (routeTestProjects) Get(context.Context, string) (Project, error) { return Project{}, nil }
func (routeTestProjects) Save(context.Context, string, application.ProjectInput) (Project, error) {
	return Project{}, nil
}

type routeTestExports struct{}

func (routeTestExports) Create(context.Context, domain.Principal, string, Project, ExportInput) (Job, error) {
	return Job{}, nil
}

type routeTestBatchExports struct {
	submits  int
	progress int
	cancels  int
}

func (b *routeTestBatchExports) Submit(context.Context, application.BatchExportRequest) (string, []application.Job, error) {
	b.submits++
	return "b_aaaaaaaaaaaa", []application.Job{{ID: "j_aaaaaaaaaaaa", State: "queued"}}, nil
}
func (b *routeTestBatchExports) Progress(context.Context, string) (store.JobState, float64, error) {
	b.progress++
	return store.JobRunning, 0.5, nil
}
func (b *routeTestBatchExports) Cancel(context.Context, string) error {
	b.cancels++
	return nil
}

type routeTestJobs struct {
	gets, cancels int
	job           Job
}

func (j *routeTestJobs) Get(context.Context, domain.Principal, string) (Job, error) {
	j.gets++
	return j.job, nil
}
func (j *routeTestJobs) Cancel(context.Context, domain.Principal, string) error {
	j.cancels++
	return nil
}

type routeTestDetection struct{ gets, cancels int }

func (d *routeTestDetection) Create(context.Context, domain.Principal, string, DetectionRequest) (DetectionJob, error) {
	return DetectionJob{}, nil
}
func (d *routeTestDetection) Get(context.Context, domain.Principal, string) (DetectionJob, error) {
	d.gets++
	return DetectionJob{
		ID: "j_detection", Type: "detection", State: "succeeded",
		MediaID: "m_media", ProjectID: "p_project", ProjectRevision: 7, Kind: domain.DetectSilence,
		Candidates: []domain.Candidate{{ID: "c_candidate", MediaID: "m_media", ProjectID: "p_project", ProjectRevision: 7, StartMS: 100, EndMS: 200, Source: domain.DetectSilence, Confidence: 0.9}},
	}, nil
}
func (d *routeTestDetection) Cancel(context.Context, domain.Principal, string) error {
	d.cancels++
	return nil
}

func TestDetectionJobsDispatchThroughDetectionService(t *testing.T) {
	authenticator, err := NewAuthenticator(AuthConfig{Mode: "none"})
	if err != nil {
		t.Fatal(err)
	}
	detection := &routeTestDetection{}
	jobs := &routeTestJobs{job: Job{
		ID: "j_detection", Type: "detection", State: "succeeded", MediaID: "m_media", ProjectID: "p_project", ProjectRevision: 7, Kind: domain.DetectSilence,
		Candidates: []domain.Candidate{{ID: "c_candidate", MediaID: "m_media", ProjectID: "p_project", ProjectRevision: 7, StartMS: 100, EndMS: 200, Source: domain.DetectSilence, Confidence: 0.9}},
	}}
	server, err := New(Config{Authenticator: authenticator, Media: &routeTestMedia{}, Preview: routeTestPreview{}, Projects: routeTestProjects{}, Exports: routeTestExports{}, Detection: detection, Jobs: jobs})
	if err != nil {
		t.Fatal(err)
	}
	for _, method := range []string{http.MethodGet, http.MethodDelete} {
		recorder := httptest.NewRecorder()
		request := httptest.NewRequest(method, "http://api.test/api/v1/jobs/j_"+strings.Repeat("d", 12), nil)
		server.ServeHTTP(recorder, request)
		want := http.StatusNoContent
		if method == http.MethodGet {
			want = http.StatusOK
		}
		if recorder.Code != want {
			t.Fatalf("%s status=%d, want %d", method, recorder.Code, want)
		}
		if method == http.MethodGet {
			var body map[string]any
			if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
				t.Fatalf("decode detection response: %v", err)
			}
			for _, key := range []string{"id", "type", "state", "mediaId", "projectId", "projectRevision", "kind", "candidates"} {
				if _, ok := body[key]; !ok {
					t.Errorf("response missing JSON field %q: %s", key, recorder.Body.String())
				}
			}
			if _, ok := body["ID"]; ok {
				t.Error("response contains Go field name ID")
			}
			candidates, ok := body["candidates"].([]any)
			if !ok || len(candidates) != 1 {
				t.Fatalf("candidates=%#v", body["candidates"])
			}
			candidate := candidates[0].(map[string]any)
			for _, key := range []string{"id", "mediaId", "projectId", "projectRevision", "startMs", "endMs", "source", "confidence"} {
				if _, ok := candidate[key]; !ok {
					t.Errorf("candidate missing JSON field %q: %#v", key, candidate)
				}
			}
		}
	}
	if detection.gets != 0 || detection.cancels != 0 || jobs.gets != 1 || jobs.cancels != 1 {
		t.Fatalf("detection dispatch gets=%d cancels=%d; unified gets=%d cancels=%d", detection.gets, detection.cancels, jobs.gets, jobs.cancels)
	}
}

func TestAssetHeadersArePrivateAndInputsBounded(t *testing.T) {
	authenticator, _ := NewAuthenticator(AuthConfig{Mode: "none"})
	id := "m_" + strings.Repeat("a", 43)
	media := &assetTestMedia{id: id}
	server, err := New(Config{Authenticator: authenticator, Media: media, Assets: routeTestAssets{}, Preview: routeTestPreview{}, Projects: routeTestProjects{}, Exports: routeTestExports{}, Jobs: &routeTestJobs{}})
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet, "http://api.test/api/v1/media/"+id+"/thumbnails?startMs=0&durationMs=1000&count=1&width=80", nil)
	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || rec.Header().Get("Cache-Control") != "private, no-cache" || rec.Header().Get("ETag") == "" {
		t.Fatalf("status=%d cache=%q etag=%q", rec.Code, rec.Header().Get("Cache-Control"), rec.Header().Get("ETag"))
	}
	cached := httptest.NewRequest(http.MethodGet, "http://api.test/api/v1/media/"+id+"/thumbnails?startMs=0&durationMs=1000&count=1&width=80", nil)
	cached.Header.Set("If-None-Match", rec.Header().Get("ETag"))
	rec = httptest.NewRecorder()
	server.ServeHTTP(rec, cached)
	if rec.Code != http.StatusNotModified {
		t.Fatalf("conditional status=%d", rec.Code)
	}
	bad := httptest.NewRequest(http.MethodGet, "http://api.test/api/v1/media/"+id+"/thumbnails?startMs=0&durationMs=1000&count=33&width=80", nil)
	rec = httptest.NewRecorder()
	server.ServeHTTP(rec, bad)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("bad bounds status=%d", rec.Code)
	}
}

type assetTestMedia struct{ id string }

func (m *assetTestMedia) List(context.Context, string, int) (MediaPage, error) {
	return MediaPage{}, nil
}
func (m *assetTestMedia) Browse(context.Context, string, string, int) (FolderPage, error) {
	return FolderPage{}, nil
}
func (m *assetTestMedia) Get(context.Context, string) (Media, error) {
	return Media{ID: m.id, DurationMS: 1000, Streams: map[string]any{"audio": map[string]any{}}}, nil
}
func (m *assetTestMedia) RefreshMedia(context.Context) error { return nil }
func (m *assetTestMedia) Status() LibraryStatus {
	return LibraryStatus{State: LibraryReadyEmpty, Message: "No supported media was found."}
}

func TestServerRejectsEncodedSlashInMediaID(t *testing.T) {
	authenticator, err := NewAuthenticator(AuthConfig{Mode: "none"})
	if err != nil {
		t.Fatal(err)
	}
	media := &routeTestMedia{}
	server, err := New(Config{
		Authenticator: authenticator,
		Media:         media,
		Preview:       routeTestPreview{},
		Projects:      routeTestProjects{},
		Exports:       routeTestExports{},
		Jobs:          &routeTestJobs{},
	})
	if err != nil {
		t.Fatal(err)
	}
	id := "m_" + strings.Repeat("a", 43)
	request := httptest.NewRequest(http.MethodGet, "http://api.test/api/v1/media/"+id+"%2Fpreview", nil)
	recorder := httptest.NewRecorder()
	server.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("status=%d, want %d", recorder.Code, http.StatusNotFound)
	}
	if media.gets != 0 {
		t.Fatal("encoded slash was dispatched to the media handler")
	}
}

func TestAutomationRequiresBearerLoopbackAndNoOrigin(t *testing.T) {
	authenticator, err := NewAuthenticator(AuthConfig{Mode: "bearer", BearerToken: "secret"})
	if err != nil {
		t.Fatal(err)
	}
	newServer := func(address string) *Server {
		server, err := New(Config{Authenticator: authenticator, Media: &routeTestMedia{}, Preview: routeTestPreview{}, Projects: routeTestProjects{}, Exports: routeTestExports{}, Jobs: &routeTestJobs{}, ListenerAddress: address, RequireAutomationAuth: true})
		if err != nil {
			t.Fatal(err)
		}
		return server
	}
	request := func(server *Server, token, origin string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "http://api.test/api/v1/automation", strings.NewReader(`{"action":"job.status","jobId":"j_aaaaaaaaaaaa"}`))
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		rec := httptest.NewRecorder()
		server.ServeHTTP(rec, req)
		return rec
	}
	if got := request(newServer("127.0.0.1"), "", "").Code; got != http.StatusUnauthorized {
		t.Fatalf("unauthenticated=%d", got)
	}
	for _, address := range []string{"192.0.2.1", "", "not-an-ip"} {
		if got := request(newServer(address), "secret", "").Code; got != http.StatusForbidden {
			t.Fatalf("listener %q status=%d", address, got)
		}
	}
	if got := request(newServer("127.0.0.1"), "secret", "https://example.test").Code; got != http.StatusForbidden {
		t.Fatalf("origin=%d", got)
	}
	tooLarge := httptest.NewRequest(http.MethodPost, "http://api.test/api/v1/automation", strings.NewReader(`{"action":"job.status","jobId":"j_aaaaaaaaaaaa","input":"`+strings.Repeat("x", maxAutomationBodyBytes)+`"}`))
	tooLarge.Header.Set("Authorization", "Bearer secret")
	recorder := httptest.NewRecorder()
	newServer("127.0.0.1").ServeHTTP(recorder, tooLarge)
	if recorder.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("body limit=%d", recorder.Code)
	}
	unsupported := httptest.NewRequest(http.MethodPost, "http://api.test/api/v1/automation", strings.NewReader(`{"action":"filesystem.read","path":"/secret/source"}`))
	unsupported.Header.Set("Authorization", "Bearer secret")
	recorder = httptest.NewRecorder()
	newServer("127.0.0.1").ServeHTTP(recorder, unsupported)
	if recorder.Code != http.StatusUnprocessableEntity || strings.Contains(recorder.Body.String(), "/secret/source") {
		t.Fatalf("unsupported command response=%s", recorder.Body.String())
	}
}

func TestValidOpaqueIDs(t *testing.T) {
	if !validMediaID("m_"+strings.Repeat("a", 43)) || validMediaID("m_"+strings.Repeat("a", 42)) {
		t.Fatal("media ID validation")
	}
	if !validProjectID("p_"+strings.Repeat("a", 12)) || validProjectID("p_"+strings.Repeat("a", 11)) {
		t.Fatal("project ID validation")
	}
	if !validJobID("j_"+strings.Repeat("a", 12)) || validJobID("j_"+strings.Repeat("a", 11)) {
		t.Fatal("job ID validation")
	}
}
