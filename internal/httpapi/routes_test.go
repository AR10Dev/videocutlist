package httpapi

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"strings"
	"testing"
	"videocutlist/internal/jobs/view"

	jobqueue "videocutlist/internal/jobs/model"
	librarymedia "videocutlist/internal/library/media"
	"videocutlist/internal/projects"
	"videocutlist/internal/projects/model"
)

func TestV2RouteBoundaries(t *testing.T) {
	media := "m_" + strings.Repeat("a", 43)
	for _, test := range []struct{ method, path string }{
		{http.MethodGet, "/api/v1/media/" + media},
		{http.MethodGet, "/api/v2/media/" + media + "/preview"},
		{http.MethodGet, "/media/v1/media/" + media + "/preview"},
		{http.MethodGet, "/media/v2/media/../../etc/passwd"},
	} {
		if got := parseRoute(test.method, test.path); got.kind != routeUnknown {
			t.Errorf("legacy, cross-boundary, or traversal route %s %s was accepted: %#v", test.method, test.path, got)
		}
	}
}

func TestRouteForUsesBoundedMetricLabels(t *testing.T) {
	for _, test := range []struct {
		path, want string
	}{
		{"/metrics", "/metrics"},
		{"/api/v2/unknown/" + strings.Repeat("secret", 20), "/api/v2/unknown"},
		{"/api/not-a-route", "/api/v2/unknown"},
		{"/unknown/" + strings.Repeat("secret", 20), "/unknown"},
	} {
		if got := routeFor(test.path); got != test.want {
			t.Errorf("routeFor(%q) = %q, want %q", test.path, got, test.want)
		}
	}
}

// routeCoverage is the production route inventory. Keep one entry here for every
// routeKind so adding a route without a black-box case fails this check.
func TestRouteCoverageInventory(t *testing.T) {
	media := "m_" + strings.Repeat("a", 43)
	project := "p_" + strings.Repeat("b", 12)
	job := "j_" + strings.Repeat("c", 12)
	batch := "b_" + strings.Repeat("d", 12)
	credential := "c_" + strings.Repeat("e", 12)
	proposal := "ep_" + strings.Repeat("f", 12)
	inventory := []struct {
		method, path string
		kind         routeKind
		id           string
	}{
		{http.MethodGet, "/api/v2/media", routeListMedia, ""},
		{http.MethodGet, "/api/v2/media/tree", routeBrowseMedia, ""},
		{http.MethodGet, "/api/v2/media/status", routeMediaStatus, ""},
		{http.MethodPost, "/api/v2/media/refresh", routeRefreshMedia, ""},
		{http.MethodPost, "/api/v2/settings/media/refresh", routeRefreshSettings, ""},
		{http.MethodPost, "/api/v2/media/import", routeStartMediaImport, ""},
		{http.MethodGet, "/api/v2/media/import/" + job, routeGetMediaImport, job},
		{http.MethodDelete, "/api/v2/media/import/" + job, routeCancelMediaImport, job},
		{http.MethodGet, "/api/v2/media/" + media, routeGetMedia, media},
		{http.MethodGet, "/media/v2/media/" + media + "/preview", routePreview, media},
		{http.MethodHead, "/media/v2/media/" + media + "/preview", routePreview, media},
		{http.MethodGet, "/media/v2/media/" + media + "/thumbnails", routeThumbnails, media},
		{http.MethodGet, "/media/v2/media/" + media + "/waveform", routeWaveform, media},
		{http.MethodGet, "/api/v2/projects", routeListProjects, ""},
		{http.MethodGet, "/api/v2/projects/" + project, routeGetProject, project},
		{http.MethodPut, "/api/v2/projects/" + project, routePutProject, project},
		{http.MethodPost, "/api/v2/projects/" + project + "/exports", routeCreateExport, project},
		{http.MethodPost, "/api/v2/projects/" + project + "/exports/preflight", routePreflightExport, project},
		{http.MethodPost, "/api/v2/projects/" + project + "/interchange/csv", routeImportInterchange, project + ":csv"},
		{http.MethodGet, "/media/v2/projects/" + project + "/interchange/chapters", routeExportInterchange, project + ":chapters"},
		{http.MethodGet, "/media/v2/projects/" + project + "/interchange/csv", routeExportInterchange, project + ":csv"},
		{http.MethodPost, "/api/v2/projects/" + project + "/detections", routeCreateDetection, project},
		{http.MethodGet, "/api/v2/jobs/" + job, routeGetJob, job},
		{http.MethodGet, "/api/v2/jobs/" + job + "/events", routeStreamJob, job},
		{http.MethodGet, "/api/v2/batches/" + batch + "/events", routeStreamBatch, batch},
		{http.MethodDelete, "/api/v2/jobs/" + job, routeCancelJob, job},
		{http.MethodPost, "/api/v2/jobs/" + job + "/retry", routeRetryJob, job},
		{http.MethodGet, "/media/v2/jobs/" + job + "/outputs/0", routeDownloadOutput, job + ":0"},
		{http.MethodGet, "/api/v2/batches", routeListBatches, ""},
		{http.MethodGet, "/media/v2/batches/" + batch + "/download", routeDownloadBatch, batch},
		{http.MethodGet, "/api/v2/batches/" + batch, routeGetBatch, batch},
		{http.MethodDelete, "/api/v2/batches/" + batch, routeCancelBatch, batch},
		{http.MethodPost, "/api/v2/automation", routeAutomation, ""},
		{http.MethodGet, "/api/v2/destinations", routeListDestinations, ""},
		{http.MethodGet, "/api/v2/settings", routeGetSettings, ""},
		{http.MethodPut, "/api/v2/settings", routePutSettings, ""},
		{http.MethodGet, "/api/v2/export-proposals/" + proposal, routeGetExportProposal, proposal},
		{http.MethodPost, "/api/v2/export-proposals/" + proposal + "/approval", routeApproveExportProposal, proposal},
		{http.MethodGet, "/api/v2/settings/mcp", routeGetMCPSettings, ""},
		{http.MethodPost, "/api/v2/settings/mcp/credentials", routeCreateMCPCredential, ""},
		{http.MethodDelete, "/api/v2/settings/mcp/credentials/" + credential, routeRevokeMCPCredential, credential},
	}
	contract := openAPIOperations(t)
	normalize := strings.NewReplacer(media, "{mediaId}", project, "{projectId}", job, "{jobId}", batch, "{batchId}", credential, "{credentialId}", proposal, "{proposalId}", "/outputs/0", "/outputs/{position}", "/interchange/csv", "/interchange/{format}", "/interchange/chapters", "/interchange/{format}")
	covered := make(map[string]bool)
	seen := make(map[routeKind]bool, len(inventory))
	for _, entry := range inventory {
		operationPath := entry.path
		if strings.HasPrefix(operationPath, "/api/v2/") {
			operationPath = strings.TrimPrefix(operationPath, "/api/v2")
		} else if strings.HasPrefix(operationPath, "/media/v2/") {
			operationPath = strings.TrimPrefix(operationPath, "/media/v2")
		}
		operation := entry.method + " " + normalize.Replace(operationPath)
		if !contract[operation] {
			t.Errorf("production operation missing from OpenAPI: %s", operation)
		}
		covered[operation] = true
		if got := parseRoute(entry.method, entry.path); got.kind != entry.kind || got.id != entry.id {
			t.Errorf("%s %s: got route %#v, want kind=%d id=%q", entry.method, entry.path, got, entry.kind, entry.id)
		}
		seen[entry.kind] = true
	}
	for kind := routeListMedia; kind <= routeStreamBatch; kind++ {
		if !seen[kind] {
			t.Errorf("route kind %d is missing from the production route inventory", kind)
		}
	}
	for _, path := range []string{"/metrics", "/health", "/ready"} {
		operation := http.MethodGet + " " + path
		if !contract[operation] {
			t.Errorf("missing operational endpoint: %s", operation)
		}
		covered[operation] = true
	}
	for operation := range contract {
		if !covered[operation] {
			t.Errorf("OpenAPI operation missing from production inventory: %s", operation)
		}
	}
	if len(seen) != int(routeStreamBatch) {
		t.Fatalf("route inventory accounts for %d kinds, want %d", len(seen), routeStreamBatch)
	}
}

func TestRouteDispatchRejectsMalformedAndNoncanonicalPaths(t *testing.T) {
	valid := "m_" + strings.Repeat("a", 43)
	cases := []struct {
		method string
		path   string
	}{
		{http.MethodGet, "/api/v2/media/%ZZ"},
		{http.MethodGet, "/api/v2/media/%2e%2e/etc"},
		{http.MethodGet, "/api/v2/media/" + valid + "%2Fpreview"},
		{http.MethodGet, "/api/v2/media/" + valid + "%5cpreview"},
		{http.MethodGet, "/api/v2//media/" + valid},
		{http.MethodPatch, "/api/v2/media"},
		{http.MethodHead, "/api/v2/media"},
	}
	for _, tc := range cases {
		t.Run(tc.method+" "+tc.path, func(t *testing.T) {
			if got := parseRoute(tc.method, tc.path); got.kind != routeUnknown {
				t.Fatalf("parseRoute accepted malformed/noncanonical route: %#v", got)
			}
			if tc.method == http.MethodGet && validRoutePath(tc.path) {
				t.Fatalf("validRoutePath accepted %q", tc.path)
			}
		})
	}
	if got := parseRoute(http.MethodHead, "/media/v2/media/"+valid+"/preview"); got.kind != routePreview {
		t.Fatalf("preview HEAD route = %#v, want preview", got)
	}
	if got := parseRoute(http.MethodHead, "/media/v2/media/"+valid+"/thumbnails"); got.kind != routeUnknown {
		t.Fatalf("non-preview HEAD route = %#v, want unknown", got)
	}
}

func TestProductionRouterRejectsMalformedDownloadPositions(t *testing.T) {
	download := &routeTestDownload{}
	server := &Server{config: Config{Download: download}}
	mux := newRouteMux(server)
	job := "j_" + strings.Repeat("a", 12)
	for _, path := range []string{
		"/media/v2/jobs/" + job + "/outputs/not-a-position",
		"/media/v2/jobs/" + job + "/outputs/-1",
		"/media/v2/jobs/" + job + "/outputs/1:2",
		"/media/v2/jobs/" + job + "/outputs/1%3A2",
	} {
		t.Run(path, func(t *testing.T) {
			response := httptest.NewRecorder()
			mux.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "http://api.test"+path, nil))
			if response.Code != http.StatusNotFound {
				t.Fatalf("status=%d, want 404: %s", response.Code, response.Body.String())
			}
		})
	}
	if download.calls != 0 {
		t.Fatal("malformed download position reached the download service")
	}
}

type routeTestDownload struct{ calls int }

func (d *routeTestDownload) Download(context.Context, string, int) (io.ReadCloser, string, error) {
	d.calls++
	return io.NopCloser(strings.NewReader("unexpected")), "output.mkv", nil
}

func TestProductionRouterRejectsMalformedPathsAndMethods(t *testing.T) {
	authenticator, err := NewAuthenticator(AuthConfig{Mode: "none"})
	if err != nil {
		t.Fatal(err)
	}
	media := &routeTestMedia{}
	projects := &routeTestCountingProjects{}
	server, err := New(Config{Authenticator: authenticator, Media: media, Preview: routeTestPreview{}, Projects: projects, BatchExports: &routeTestBatchExports{}, Jobs: &routeTestJobs{}})
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct{ method, path string }{
		{http.MethodGet, "/api/v2/media/m_bad"},
		{http.MethodGet, "/api/v2/projects/m_" + strings.Repeat("a", 43)},
		{http.MethodGet, "/media/v2/media/m_" + strings.Repeat("a", 43)},
		{http.MethodGet, "/api/v2/media/%2e%2e/etc"},
		{http.MethodGet, "/api/v2/media/m_" + strings.Repeat("a", 43) + "%2Fpreview"},
		{http.MethodGet, "/api/v2/media/m_" + strings.Repeat("a", 43) + "%5cpreview"},
		{http.MethodPost, "/api/v2/projects/p_" + strings.Repeat("b", 12) + "/interchange/json"},
		{http.MethodGet, "/media/v2/projects/p_" + strings.Repeat("b", 12) + "/interchange/json"},
		{http.MethodGet, "/api/v2//media"},
		{http.MethodPatch, "/api/v2/media"},
		{http.MethodHead, "/api/v2/media"},
		{http.MethodHead, "/media/v2/media/m_" + strings.Repeat("a", 43) + "/thumbnails"},
	}
	for _, tc := range cases {
		t.Run(tc.method+" "+tc.path, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			server.ServeHTTP(recorder, httptest.NewRequest(tc.method, "http://api.test"+tc.path, nil))
			assertRouteNotFound(t, recorder)
		})
	}
	if media.gets != 0 || projects.gets != 0 {
		t.Fatalf("invalid routes invoked domains: media=%d projects=%d", media.gets, projects.gets)
	}

	// net/http's request constructor rejects malformed escapes before ServeHTTP;
	// send the raw request line to exercise the actual production socket parser.
	listener := httptest.NewServer(server)
	defer listener.Close()
	address := strings.TrimPrefix(listener.URL, "http://")
	conn, err := net.Dial("tcp", address)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := conn.Close(); err != nil {
			t.Error(err)
		}
	}()
	if _, err := io.WriteString(conn, "GET /api/v2/media/%ZZ HTTP/1.1\r\nHost: api.test\r\nConnection: close\r\n\r\n"); err != nil {
		t.Fatal(err)
	}
	response, err := http.ReadResponse(bufio.NewReader(conn), &http.Request{Method: http.MethodGet})
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := response.Body.Close(); err != nil {
			t.Error(err)
		}
	}()
	if response.StatusCode != http.StatusBadRequest {
		t.Fatalf("raw malformed escape status=%d", response.StatusCode)
	}
}

func assertRouteNotFound(t *testing.T, response *httptest.ResponseRecorder) {
	t.Helper()
	if response.Code != http.StatusNotFound || response.Header().Get("Location") != "" {
		t.Fatalf("status=%d location=%q body=%s", response.Code, response.Header().Get("Location"), response.Body.String())
	}
	var envelope struct {
		Error struct {
			Code      string `json:"code"`
			Message   string `json:"message"`
			RequestID string `json:"requestId"`
		} `json:"error"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil || envelope.Error.Code != "not_found" || envelope.Error.Message == "" || envelope.Error.RequestID == "" || response.Header().Get("X-Request-ID") != envelope.Error.RequestID {
		t.Fatalf("invalid error envelope/header: %s (%v)", response.Body.String(), err)
	}
}

func TestProductionRouteLabelsStayBounded(t *testing.T) {
	var logs bytes.Buffer
	metrics := NewMetrics()
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
		BatchExports:  &routeTestBatchExports{},
		Jobs:          &routeTestJobs{},
		Logger:        log.New(&logs, "", 0),
		Metrics:       metrics,
	})
	if err != nil {
		t.Fatal(err)
	}
	validID := "m_" + strings.Repeat("q", 43)
	invalidPath := "/api/v2/media/private-route-label-secret"
	for _, path := range []string{invalidPath, "/api/v2/media/" + validID} {
		response := httptest.NewRecorder()
		server.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "http://api.test"+path, nil))
		if path == invalidPath {
			assertRouteNotFound(t, response)
		} else if response.Code != http.StatusOK {
			t.Fatalf("valid route status=%d body=%s", response.Code, response.Body.String())
		}
	}
	if media.gets != 1 {
		t.Fatalf("media domain calls=%d, want only valid ID dispatched", media.gets)
	}
	if strings.Contains(logs.String(), "private-route-label-secret") || strings.Contains(logs.String(), validID) {
		t.Fatalf("logs contain raw route identifier: %s", logs.String())
	}
	var entries []struct {
		Route string `json:"route"`
	}
	for _, line := range strings.Split(strings.TrimSpace(logs.String()), "\n") {
		var entry struct {
			Route string `json:"route"`
		}
		if err := json.Unmarshal([]byte(line), &entry); err != nil {
			t.Fatalf("decode route log %q: %v", line, err)
		}
		entries = append(entries, entry)
	}
	if len(entries) != 2 || entries[0].Route != "/api/v2/unknown" || entries[1].Route != "/api/v2/media/{mediaId}" {
		t.Fatalf("production log routes = %#v", entries)
	}
	families, err := metrics.registry.Gather()
	if err != nil {
		t.Fatal(err)
	}
	for _, metric := range []struct {
		route, status string
		want          float64
	}{
		{"/api/v2/unknown", "4xx", 1},
		{"/api/v2/media/{mediaId}", "2xx", 1},
	} {
		labels := map[string]string{"route": metric.route, "method": http.MethodGet, "status_class": metric.status}
		if got := metricValue(families, "http_requests_total", labels); got != metric.want {
			t.Errorf("production metric %v = %v, want %v", labels, got, metric.want)
		}
	}
	for _, family := range families {
		for _, metric := range family.GetMetric() {
			for _, label := range metric.GetLabel() {
				if strings.Contains(label.GetValue(), validID) || strings.Contains(label.GetValue(), "private-route-label-secret") {
					t.Fatalf("metric %s label %s contains raw route data %q", family.GetName(), label.GetName(), label.GetValue())
				}
			}
		}
	}
}

func TestParseRouteRejectsMalformedIDsAndPaths(t *testing.T) {
	valid := "m_" + strings.Repeat("a", 43)
	for _, path := range []string{
		"/api/v2/media/m_bad",
		"/api/v2/media/" + valid + "/extra",
		"/api/v2/media/../etc/passwd",
		"/api/v2/media/" + valid + "%2Fpreview",
		"/media/v2/media/" + valid + "/preview/extra",
	} {
		if got := parseRoute(http.MethodGet, path); got.kind != routeUnknown {
			t.Errorf("%s: got %#v", path, got)
		}
	}
	if got := parseRoute(http.MethodPost, "/api/v2/media"); got.kind != routeUnknown {
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

func (m *routeTestMedia) List(context.Context, string, int) (librarymedia.MediaPage, error) {
	return librarymedia.MediaPage{}, nil
}
func (m *routeTestMedia) Browse(_ context.Context, folderID, cursor string, limit int) (librarymedia.FolderPage, error) {
	m.browses++
	m.folderID, m.cursor, m.browseLimit = folderID, cursor, limit
	return librarymedia.FolderPage{Folders: []librarymedia.FolderNode{{ID: "f_folder", Label: "Folder"}}}, nil
}
func (m *routeTestMedia) Get(context.Context, string) (librarymedia.Media, error) {
	m.gets++
	return librarymedia.Media{}, nil
}
func (m *routeTestMedia) RefreshMedia(context.Context) error { return nil }
func (m *routeTestMedia) Status() librarymedia.LibraryStatus {
	return librarymedia.LibraryStatus{State: librarymedia.LibraryReadyEmpty, Message: "No supported media was found."}
}

type routeTestMediaImport struct {
	starts int
	err    error
	key    string
}

func (m *routeTestMediaImport) StartImport(_ context.Context, key string) (librarymedia.ImportJob, error) {
	m.starts++
	m.key = key
	return librarymedia.ImportJob{ID: "j_scanresult1234", State: "queued"}, m.err
}
func (m *routeTestMediaImport) ImportStatus(context.Context, string) (librarymedia.ImportJob, error) {
	return librarymedia.ImportJob{}, nil
}
func (m *routeTestMediaImport) CancelImport(context.Context, string) error { return nil }

func TestRefreshMediaSubmitsUnifiedScanJob(t *testing.T) {
	authenticator, err := NewAuthenticator(AuthConfig{Mode: "none"})
	if err != nil {
		t.Fatal(err)
	}
	imports := &routeTestMediaImport{}
	server, err := New(Config{Authenticator: authenticator, Media: &routeTestMedia{}, MediaImport: imports, Preview: routeTestPreview{}, Projects: routeTestProjects{}, BatchExports: &routeTestBatchExports{}, Jobs: &routeTestJobs{}})
	if err != nil {
		t.Fatal(err)
	}
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/v2/media/refresh", nil)
	request.Header.Set("Idempotency-Key", "scan-key")
	server.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusAccepted || imports.starts != 1 || imports.key != "scan-key" {
		t.Fatalf("refresh status=%d starts=%d key=%q body=%s", recorder.Code, imports.starts, imports.key, recorder.Body.String())
	}

	for _, path := range []string{"/api/v2/media/refresh", "/api/v2/settings/media/refresh", "/api/v2/media/import"} {
		for _, key := range []string{"", "bad key", strings.Repeat("x", 129)} {
			request = httptest.NewRequest(http.MethodPost, path, nil)
			if key != "" {
				request.Header.Set("Idempotency-Key", key)
			}
			recorder = httptest.NewRecorder()
			server.ServeHTTP(recorder, request)
			if recorder.Code != http.StatusBadRequest || imports.starts != 1 || !strings.Contains(recorder.Body.String(), `"code":"invalid_idempotency_key"`) {
				t.Fatalf("invalid key %q at %s status=%d starts=%d body=%s", key, path, recorder.Code, imports.starts, recorder.Body.String())
			}
		}
	}

	request = httptest.NewRequest(http.MethodPost, "/api/v2/settings/media/refresh", nil)
	request.Header.Set("Idempotency-Key", "scan-key")
	recorder = httptest.NewRecorder()
	server.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusAccepted || imports.starts != 2 || imports.key != "scan-key" {
		t.Fatalf("settings refresh status=%d starts=%d key=%q body=%s", recorder.Code, imports.starts, imports.key, recorder.Body.String())
	}

	imports.err = jobqueue.ErrAdmissionConflict
	request = httptest.NewRequest(http.MethodPost, "/api/v2/media/import", nil)
	request.Header.Set("Idempotency-Key", "scan-key")
	recorder = httptest.NewRecorder()
	server.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusConflict || !strings.Contains(recorder.Body.String(), `"code":"idempotency_conflict"`) {
		t.Fatalf("conflicting import status=%d body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestBatchExportEndpointsUseInjectedService(t *testing.T) {
	authenticator, err := NewAuthenticator(AuthConfig{Mode: "none"})
	if err != nil {
		t.Fatal(err)
	}
	batch := &routeTestBatchExports{}
	server, err := New(Config{Authenticator: authenticator, Media: &routeTestMedia{}, Preview: routeTestPreview{}, Projects: routeTestProjects{}, BatchExports: batch, Jobs: &routeTestJobs{}})
	if err != nil {
		t.Fatal(err)
	}
	project := "p_" + strings.Repeat("a", 12)
	batchID := "b_" + strings.Repeat("a", 12)
	request := httptest.NewRequest(http.MethodPost, "/api/v2/projects/"+project+"/exports", strings.NewReader(`{"projectRevision":1,"itemIds":["i_aaaaaaaaaaaaaaaaaaaaaaaa"]}`))
	request.Header.Set("Idempotency-Key", "route-export-key")
	recorder := httptest.NewRecorder()
	server.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusAccepted || batch.submits != 1 {
		t.Fatalf("submit status=%d submits=%d body=%s", recorder.Code, batch.submits, recorder.Body.String())
	}
	for _, method := range []string{http.MethodGet, http.MethodDelete} {
		recorder = httptest.NewRecorder()
		server.ServeHTTP(recorder, httptest.NewRequest(method, "/api/v2/batches/"+batchID, nil))
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

func TestBatchListValidatesOpaquePaginationAndReturnsNullableCursor(t *testing.T) {
	authenticator, err := NewAuthenticator(AuthConfig{Mode: "none"})
	if err != nil {
		t.Fatal(err)
	}
	next := "opaque-next-cursor"
	batch := &routeTestBatchExports{listPage: projects.BatchPage{Items: []projects.Batch{}, NextCursor: &next}}
	server, err := New(Config{Authenticator: authenticator, Media: &routeTestMedia{}, Preview: routeTestPreview{}, Projects: routeTestProjects{}, BatchExports: batch, Jobs: &routeTestJobs{}})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodGet, "/api/v2/batches?cursor=opaque-request-cursor&limit=25", nil)
	response := httptest.NewRecorder()
	server.ServeHTTP(response, request)
	if response.Code != http.StatusOK || batch.listCursor != "opaque-request-cursor" || batch.listLimit != 25 || !strings.Contains(response.Body.String(), `"nextCursor":"opaque-next-cursor"`) {
		t.Fatalf("batch page status=%d cursor=%q limit=%d body=%s", response.Code, batch.listCursor, batch.listLimit, response.Body.String())
	}

	batch.listPage = projects.BatchPage{Items: []projects.Batch{}}
	response = httptest.NewRecorder()
	server.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/v2/batches", nil))
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"nextCursor":null`) {
		t.Fatalf("empty final page status=%d body=%s", response.Code, response.Body.String())
	}

	batch.listErr = projects.ErrInvalidBatchCursor
	response = httptest.NewRecorder()
	server.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/v2/batches?cursor=invalid", nil))
	if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), `"code":"invalid_query"`) {
		t.Fatalf("malformed cursor status=%d body=%s", response.Code, response.Body.String())
	}

	batch.listErr = nil
	for _, query := range []string{
		"?limit=0", "?limit=101", "?limit=25&limit=50", "?cursor=short&cursor=duplicate", "?unknown=1", "?cursor=" + strings.Repeat("x", 257),
	} {
		response = httptest.NewRecorder()
		server.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/v2/batches"+query, nil))
		if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), `"code":"invalid_query"`) {
			t.Errorf("query %q status=%d body=%s", query, response.Code, response.Body.String())
		}
	}
}

func TestBrowseMediaDispatchesOpaqueQueryToProductionService(t *testing.T) {
	authenticator, err := NewAuthenticator(AuthConfig{Mode: "none"})
	if err != nil {
		t.Fatal(err)
	}
	media := &routeTestMedia{}
	server, err := New(Config{Authenticator: authenticator, Media: media, Preview: routeTestPreview{}, Projects: routeTestProjects{}, BatchExports: &routeTestBatchExports{}, Jobs: &routeTestJobs{}})
	if err != nil {
		t.Fatal(err)
	}
	folderID := "f_" + strings.Repeat("x", 43)
	cursor := "m_" + strings.Repeat("y", 43)
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/v2/media/tree?folderId="+folderID+"&cursor="+cursor+"&limit=25", nil)
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

func TestMediaListRejectsMalformedQuery(t *testing.T) {
	authenticator, err := NewAuthenticator(AuthConfig{Mode: "none"})
	if err != nil {
		t.Fatal(err)
	}
	server, err := New(Config{Authenticator: authenticator, Media: &routeTestMedia{}, Preview: routeTestPreview{}, Projects: routeTestProjects{}, BatchExports: &routeTestBatchExports{}, Jobs: &routeTestJobs{}})
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	server.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/v2/media?limit=%ZZ", nil))
	if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), `"code":"invalid_query"`) {
		t.Fatalf("malformed query status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestMediaImportUnavailableReturnsError(t *testing.T) {
	authenticator, err := NewAuthenticator(AuthConfig{Mode: "none"})
	if err != nil {
		t.Fatal(err)
	}
	server, err := New(Config{Authenticator: authenticator, Media: &routeTestMedia{}, Preview: routeTestPreview{}, Projects: routeTestProjects{}, BatchExports: &routeTestBatchExports{}, Jobs: &routeTestJobs{}})
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/v2/media/import", nil)
	request.Header.Set("Idempotency-Key", "scan-unavailable")
	server.ServeHTTP(response, request)
	if response.Code != http.StatusConflict || !strings.Contains(response.Body.String(), `"code":"import_unavailable"`) {
		t.Fatalf("import status=%d body=%s", response.Code, response.Body.String())
	}
}

type routeTestAssets struct{}

func (routeTestAssets) ValidateSource(context.Context, string) error { return nil }
func (routeTestAssets) Thumbnails(context.Context, AssetSpec) (AssetResult, error) {
	return AssetResult{Reader: io.NopCloser(bytes.NewReader([]byte("png")))}, nil
}
func (routeTestAssets) Waveform(context.Context, AssetSpec) (AssetResult, error) {
	return AssetResult{StartMS: 0, DurationMS: 1000, Peaks: []float64{0.5}}, nil
}

type routeTestPreview struct{}

func (routeTestPreview) Start(context.Context, PreviewSpec) (PreviewResult, error) {
	return PreviewResult{}, nil
}
func (routeTestPreview) Cached(context.Context, PreviewSpec) (bool, error) { return false, nil }

type routeTestCachedPreview struct{}

func (routeTestCachedPreview) Start(context.Context, PreviewSpec) (PreviewResult, error) {
	return PreviewResult{Reader: io.NopCloser(strings.NewReader("video")), CacheStatus: "hit", StartMS: 400, DurationMS: 200, OffsetMS: 0}, nil
}
func (routeTestCachedPreview) Cached(context.Context, PreviewSpec) (bool, error) { return true, nil }

func TestV2HTTPSeparatesJSONAndNativeMediaResponses(t *testing.T) {
	authenticator, err := NewAuthenticator(AuthConfig{Mode: "none"})
	if err != nil {
		t.Fatal(err)
	}
	mediaID := "m_" + strings.Repeat("a", 43)
	server, err := New(Config{
		Authenticator: authenticator,
		Media:         &assetTestMedia{id: mediaID},
		Assets:        routeTestAssets{},
		Preview:       routeTestCachedPreview{},
		Projects:      routeTestProjects{},
		BatchExports:  &routeTestBatchExports{},
		Jobs:          &routeTestJobs{},
	})
	if err != nil {
		t.Fatal(err)
	}

	jsonResponse := httptest.NewRecorder()
	server.ServeHTTP(jsonResponse, httptest.NewRequest(http.MethodGet, "/api/v2/media/"+mediaID, nil))
	if jsonResponse.Code != http.StatusOK || jsonResponse.Header().Get("Content-Type") != "application/json; charset=utf-8" {
		t.Fatalf("JSON metadata response = %d %q %s", jsonResponse.Code, jsonResponse.Header().Get("Content-Type"), jsonResponse.Body.String())
	}

	previewPath := "/media/v2/media/" + mediaID + "/preview?centerMs=500&beforeMs=100&afterMs=100"
	preview := httptest.NewRecorder()
	server.ServeHTTP(preview, httptest.NewRequest(http.MethodGet, previewPath, nil))
	if preview.Code != http.StatusOK || preview.Header().Get("Content-Type") != "video/mp4" || preview.Body.String() != "video" || preview.Header().Get("X-Request-ID") == "" {
		t.Fatalf("preview response = %d %#v %q", preview.Code, preview.Header(), preview.Body.String())
	}
	head := httptest.NewRecorder()
	server.ServeHTTP(head, httptest.NewRequest(http.MethodHead, previewPath, nil))
	if head.Code != http.StatusOK || head.Body.Len() != 0 || head.Header().Get("X-Preview-Cache") != "hit" {
		t.Fatalf("preview HEAD response = %d %#v %q", head.Code, head.Header(), head.Body.String())
	}

	thumbnailPath := "/media/v2/media/" + mediaID + "/thumbnails?startMs=0&durationMs=1000&count=1&width=80"
	thumbnail := httptest.NewRecorder()
	server.ServeHTTP(thumbnail, httptest.NewRequest(http.MethodGet, thumbnailPath, nil))
	if thumbnail.Code != http.StatusOK || thumbnail.Header().Get("Content-Type") != "image/png" || thumbnail.Body.String() != "png" {
		t.Fatalf("thumbnail response = %d %#v %q", thumbnail.Code, thumbnail.Header(), thumbnail.Body.String())
	}
	conditionalRequest := httptest.NewRequest(http.MethodGet, thumbnailPath, nil)
	conditionalRequest.Header.Set("If-None-Match", thumbnail.Header().Get("ETag"))
	conditional := httptest.NewRecorder()
	server.ServeHTTP(conditional, conditionalRequest)
	if conditional.Code != http.StatusNotModified || conditional.Body.Len() != 0 {
		t.Fatalf("conditional thumbnail response = %d %q", conditional.Code, conditional.Body.String())
	}

	for _, path := range []string{
		"/api/v1/media/" + mediaID,
		"/media/v1/media/" + mediaID + "/preview",
		"/media/v2/media/" + mediaID + "%2Fpreview",
		"/media/v2/media/../../etc/passwd",
	} {
		rejected := httptest.NewRecorder()
		server.ServeHTTP(rejected, httptest.NewRequest(http.MethodGet, path, nil))
		if rejected.Code != http.StatusNotFound || !strings.Contains(rejected.Body.String(), `"code":"not_found"`) {
			t.Errorf("legacy or malformed route %q response = %d %s", path, rejected.Code, rejected.Body.String())
		}
	}
}

type routeTestProjects struct{}

type routeTestCountingProjects struct {
	routeTestProjects
	gets int
}

func (p *routeTestCountingProjects) Get(ctx context.Context, id string) (Project, error) {
	p.gets++
	return p.routeTestProjects.Get(ctx, id)
}

func (routeTestProjects) Create(context.Context, string, projects.ProjectInput) (Project, error) {
	return Project{}, nil
}
func (routeTestProjects) Get(context.Context, string) (Project, error) { return Project{}, nil }
func (routeTestProjects) Save(_ context.Context, id string, input projects.ProjectInput) (Project, error) {
	return Project{ID: id, Revision: 1, Document: input.Document}, nil
}

type routeTestBatchExports struct {
	submits    int
	progress   int
	cancels    int
	listCursor string
	listLimit  int
	listPage   projects.BatchPage
	listErr    error
}

func (b *routeTestBatchExports) Submit(context.Context, projects.BatchExportRequest) (string, []view.Job, error) {
	b.submits++
	return "b_aaaaaaaaaaaa", []view.Job{{ID: "j_aaaaaaaaaaaa", State: "queued"}}, nil
}
func (b *routeTestBatchExports) Progress(context.Context, string) (jobqueue.JobState, float64, error) {
	b.progress++
	return jobqueue.JobRunning, 0.5, nil
}
func (b *routeTestBatchExports) Get(context.Context, string) (projects.Batch, error) {
	b.progress++
	return projects.Batch{BatchID: "b_aaaaaaaaaaaa", State: "running", Progress: .5, Jobs: []view.Job{}}, nil
}
func (b *routeTestBatchExports) List(_ context.Context, cursor string, limit int) (projects.BatchPage, error) {
	b.listCursor, b.listLimit = cursor, limit
	if b.listErr != nil {
		return projects.BatchPage{}, b.listErr
	}
	if b.listPage.Items != nil {
		return b.listPage, nil
	}
	return projects.BatchPage{Items: []projects.Batch{}}, nil
}
func (b *routeTestBatchExports) Retry(context.Context, string, string) (projects.Batch, error) {
	return projects.Batch{BatchID: "b_aaaaaaaaaaaa", State: "queued", Jobs: []view.Job{}}, nil
}
func (b *routeTestBatchExports) Cancel(context.Context, string) error {
	b.cancels++
	return nil
}

type routeTestJobs struct {
	gets, cancels int
	job           view.Job
}

func (j *routeTestJobs) Get(context.Context, string) (view.Job, error) {
	j.gets++
	return j.job, nil
}
func (j *routeTestJobs) Cancel(context.Context, string) error {
	j.cancels++
	return nil
}

func TestDetectionJobResponsesUseUnifiedJobContract(t *testing.T) {
	authenticator, err := NewAuthenticator(AuthConfig{Mode: "none"})
	if err != nil {
		t.Fatal(err)
	}
	jobs := &routeTestJobs{job: view.Job{
		ID: "j_detection", Type: "detection", State: "succeeded", MediaID: "m_media", ProjectID: "p_project", ProjectRevision: 7, Kind: model.DetectSilence,
		Candidates: []model.Candidate{{ID: "c_candidate", MediaID: "m_media", ProjectID: "p_project", ProjectRevision: 7, StartMS: 100, EndMS: 200, Source: model.DetectSilence}},
	}}
	server, err := New(Config{Authenticator: authenticator, Media: &routeTestMedia{}, Preview: routeTestPreview{}, Projects: routeTestProjects{}, BatchExports: &routeTestBatchExports{}, Jobs: jobs})
	if err != nil {
		t.Fatal(err)
	}
	for _, method := range []string{http.MethodGet, http.MethodDelete} {
		recorder := httptest.NewRecorder()
		request := httptest.NewRequest(method, "http://api.test/api/v2/jobs/j_"+strings.Repeat("d", 12), nil)
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
			for _, key := range []string{"id", "mediaId", "projectId", "projectRevision", "startMs", "endMs", "source"} {
				if _, ok := candidate[key]; !ok {
					t.Errorf("candidate missing JSON field %q: %#v", key, candidate)
				}
			}
			if _, ok := candidate["confidence"]; ok {
				t.Error("detection response exposes fabricated confidence")
			}
		}
	}
}

func TestAssetHeadersArePrivateAndInputsBounded(t *testing.T) {
	authenticator, _ := NewAuthenticator(AuthConfig{Mode: "none"})
	id := "m_" + strings.Repeat("a", 43)
	media := &assetTestMedia{id: id}
	server, err := New(Config{Authenticator: authenticator, Media: media, Assets: routeTestAssets{}, Preview: routeTestPreview{}, Projects: routeTestProjects{}, BatchExports: &routeTestBatchExports{}, Jobs: &routeTestJobs{}})
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet, "http://api.test/media/v2/media/"+id+"/thumbnails?startMs=0&durationMs=1000&count=1&width=80", nil)
	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || rec.Header().Get("Cache-Control") != "private, no-cache" || rec.Header().Get("ETag") == "" {
		t.Fatalf("status=%d cache=%q etag=%q", rec.Code, rec.Header().Get("Cache-Control"), rec.Header().Get("ETag"))
	}
	cached := httptest.NewRequest(http.MethodGet, "http://api.test/media/v2/media/"+id+"/thumbnails?startMs=0&durationMs=1000&count=1&width=80", nil)
	cached.Header.Set("If-None-Match", rec.Header().Get("ETag"))
	rec = httptest.NewRecorder()
	server.ServeHTTP(rec, cached)
	if rec.Code != http.StatusNotModified {
		t.Fatalf("conditional status=%d", rec.Code)
	}
	bad := httptest.NewRequest(http.MethodGet, "http://api.test/media/v2/media/"+id+"/thumbnails?startMs=0&durationMs=1000&count=33&width=80", nil)
	rec = httptest.NewRecorder()
	server.ServeHTTP(rec, bad)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("bad bounds status=%d", rec.Code)
	}
}

type assetTestMedia struct{ id string }

func (m *assetTestMedia) List(context.Context, string, int) (librarymedia.MediaPage, error) {
	return librarymedia.MediaPage{}, nil
}
func (m *assetTestMedia) Browse(context.Context, string, string, int) (librarymedia.FolderPage, error) {
	return librarymedia.FolderPage{}, nil
}
func (m *assetTestMedia) Get(context.Context, string) (librarymedia.Media, error) {
	return librarymedia.Media{ID: m.id, DurationMS: 1000, Streams: map[string]any{"audio": map[string]any{}}}, nil
}
func (m *assetTestMedia) RefreshMedia(context.Context) error { return nil }
func (m *assetTestMedia) Status() librarymedia.LibraryStatus {
	return librarymedia.LibraryStatus{State: librarymedia.LibraryReadyEmpty, Message: "No supported media was found."}
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
		BatchExports:  &routeTestBatchExports{},
		Jobs:          &routeTestJobs{},
	})
	if err != nil {
		t.Fatal(err)
	}
	id := "m_" + strings.Repeat("a", 43)
	request := httptest.NewRequest(http.MethodGet, "http://api.test/api/v2/media/"+id+"%2Fpreview", nil)
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
	authenticator, err := NewAuthenticator(AuthConfig{Mode: "bearer", BearerToken: "deployment-test-secret-0123456789abcdef"})
	if err != nil {
		t.Fatal(err)
	}
	newServer := func(address string) *Server {
		server, err := New(Config{Authenticator: authenticator, Media: &routeTestMedia{}, Preview: routeTestPreview{}, Projects: routeTestProjects{}, BatchExports: &routeTestBatchExports{}, Jobs: &routeTestJobs{}, ListenerAddress: address, RequireAutomationAuth: true})
		if err != nil {
			t.Fatal(err)
		}
		return server
	}
	request := func(server *Server, token, origin string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "http://api.test/api/v2/automation", strings.NewReader(`{"action":"job.status","jobId":"j_aaaaaaaaaaaa"}`))
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
		if got := request(newServer(address), "deployment-test-secret-0123456789abcdef", "").Code; got != http.StatusForbidden {
			t.Fatalf("listener %q status=%d", address, got)
		}
	}
	if got := request(newServer("127.0.0.1"), "deployment-test-secret-0123456789abcdef", "https://example.test").Code; got != http.StatusForbidden {
		t.Fatalf("origin=%d", got)
	}
	tooLarge := httptest.NewRequest(http.MethodPost, "http://api.test/api/v2/automation", strings.NewReader(`{"action":"job.status","jobId":"j_aaaaaaaaaaaa","input":"`+strings.Repeat("x", maxAutomationBodyBytes)+`"}`))
	tooLarge.Header.Set("Authorization", "Bearer deployment-test-secret-0123456789abcdef")
	recorder := httptest.NewRecorder()
	newServer("127.0.0.1").ServeHTTP(recorder, tooLarge)
	if recorder.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("body limit=%d", recorder.Code)
	}
	unsupported := httptest.NewRequest(http.MethodPost, "http://api.test/api/v2/automation", strings.NewReader(`{"action":"filesystem.read","path":"/secret/source"}`))
	unsupported.Header.Set("Authorization", "Bearer deployment-test-secret-0123456789abcdef")
	recorder = httptest.NewRecorder()
	newServer("127.0.0.1").ServeHTTP(recorder, unsupported)
	if recorder.Code != http.StatusBadRequest || strings.Contains(recorder.Body.String(), "/secret/source") {
		t.Fatalf("unsupported command response=%s", recorder.Body.String())
	}
	for _, command := range []string{
		`{"action":"job.status","jobId":"not-an-id"}`,
		`{"action":"project.export","projectId":"not-a-project","format":"csv"}`,
		`{"action":"project.import","projectId":"not-a-project","format":"csv"}`,
	} {
		recorder = httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "http://api.test/api/v2/automation", strings.NewReader(command))
		req.Header.Set("Authorization", "Bearer deployment-test-secret-0123456789abcdef")
		newServer("127.0.0.1").ServeHTTP(recorder, req)
		if recorder.Code != http.StatusBadRequest {
			t.Fatalf("invalid command status=%d body=%s", recorder.Code, recorder.Body.String())
		}
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

// Read method/path keys from the checked-in block-style contract. The existing
// OpenAPI generator validates the complete YAML and schema references.
func openAPIOperations(t *testing.T) map[string]bool {
	t.Helper()
	file, err := os.Open("../../api/api.openapi.yaml")
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := file.Close(); err != nil {
			t.Error(err)
		}
	}()
	paths := regexp.MustCompile(`^  (/[^:]+):$`)
	methods := regexp.MustCompile(`^    (get|head|post|put|delete|patch|options):$`)
	operations := make(map[string]bool)
	scanner := bufio.NewScanner(file)
	path := ""
	for scanner.Scan() {
		line := scanner.Text()
		if line == "components:" {
			break
		}
		if match := paths.FindStringSubmatch(line); match != nil {
			path = match[1]
		}
		if match := methods.FindStringSubmatch(line); match != nil && path != "" {
			operation := strings.ToUpper(match[1]) + " " + path
			if operations[operation] {
				t.Errorf("duplicate OpenAPI operation: %s", operation)
			}
			operations[operation] = true
		}
	}
	if err := scanner.Err(); err != nil {
		t.Fatal(err)
	}
	return operations
}
