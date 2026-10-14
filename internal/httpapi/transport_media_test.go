package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"videocutlist/internal/httpapi/transport"
	librarymedia "videocutlist/internal/library/media"
)

type transportTestMedia struct {
	page   librarymedia.MediaPage
	folder librarymedia.FolderPage
	media  librarymedia.Media
}

func (m transportTestMedia) List(context.Context, string, int) (librarymedia.MediaPage, error) {
	return m.page, nil
}

func (m transportTestMedia) Browse(context.Context, string, string, int) (librarymedia.FolderPage, error) {
	return m.folder, nil
}

func (m transportTestMedia) Get(context.Context, string) (librarymedia.Media, error) {
	return m.media, nil
}

func (transportTestMedia) RefreshMedia(context.Context) error { return nil }
func (transportTestMedia) Status() librarymedia.LibraryStatus { return librarymedia.LibraryStatus{} }

type transportTestImports struct {
	job librarymedia.ImportJob
}

func (i transportTestImports) StartImport(context.Context, string) (librarymedia.ImportJob, error) {
	return i.job, nil
}

func (i transportTestImports) ImportStatus(context.Context, string) (librarymedia.ImportJob, error) {
	return i.job, nil
}

func (transportTestImports) CancelImport(context.Context, string) error { return nil }

type transportTestAssets struct {
	result AssetResult
}

func (transportTestAssets) ValidateSource(context.Context, string) error { return nil }
func (transportTestAssets) Thumbnails(context.Context, AssetSpec) (AssetResult, error) {
	return AssetResult{}, nil
}
func (a transportTestAssets) Waveform(context.Context, AssetSpec) (AssetResult, error) {
	return a.result, nil
}

func newTransportTestServer(t *testing.T, config Config) *Server {
	t.Helper()
	authenticator, err := NewAuthenticator(AuthConfig{Mode: "none"})
	if err != nil {
		t.Fatal(err)
	}
	config.Authenticator = authenticator
	if config.Preview == nil {
		config.Preview = routeTestPreview{}
	}
	config.Projects = routeTestProjects{}
	config.BatchExports = &routeTestBatchExports{}
	config.Jobs = &routeTestJobs{}
	server, err := New(config)
	if err != nil {
		t.Fatal(err)
	}
	return server
}

func TestMediaHandlersUseTypedTransportWithoutLosingMetadataOrNulls(t *testing.T) {
	const mediaID = "m_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	media := librarymedia.Media{
		ID: mediaID, RootID: "/private/media", Name: "clip.mp4", DurationMS: 1_000,
		SizeBytes: 12, Container: "mp4", ETag: "etag",
		Streams: map[string]any{"video": map[string]any{"probeIndex": int64(9_007_199_254_740_993)}},
	}
	cursor := "next-token"
	mediaService := transportTestMedia{
		page:   librarymedia.MediaPage{Items: []librarymedia.Media{media}},
		folder: librarymedia.FolderPage{Folders: []librarymedia.FolderNode{}, Items: nil, NextCursor: &cursor},
		media:  media,
	}
	server := newTransportTestServer(t, Config{Media: mediaService})

	response := httptest.NewRecorder()
	server.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/v2/media", nil))
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), "9007199254740993") || strings.Contains(response.Body.String(), "9007199254740992") {
		t.Fatalf("media list did not preserve freeform metadata: status=%d body=%s", response.Code, response.Body.String())
	}
	if strings.Contains(response.Body.String(), "/private/media") || !strings.Contains(response.Body.String(), `"nextCursor":null`) {
		t.Fatalf("media list leaked root ID or lost null cursor: %s", response.Body.String())
	}

	var list struct {
		Items      json.RawMessage `json:"items"`
		NextCursor json.RawMessage `json:"nextCursor"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	var listedItems []struct {
		Streams json.RawMessage `json:"streams"`
	}
	if err := json.Unmarshal(list.Items, &listedItems); err != nil {
		t.Fatal(err)
	}
	if len(listedItems) != 1 || string(listedItems[0].Streams) != `{"video":{"probeIndex":9007199254740993}}` || string(list.NextCursor) != "null" {
		t.Fatalf("media list payload = items %s cursor %s", list.Items, list.NextCursor)
	}

	for _, test := range []struct {
		name  string
		items []librarymedia.Media
		want  string
	}{{name: "nil items", items: nil, want: "null"}, {name: "empty items", items: []librarymedia.Media{}, want: "[]"}} {
		t.Run(test.name, func(t *testing.T) {
			mediaService.page.Items = test.items
			server.config.Media = mediaService
			response := httptest.NewRecorder()
			server.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/v2/media", nil))
			var body struct {
				Items json.RawMessage `json:"items"`
			}
			if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			if string(body.Items) != test.want {
				t.Fatalf("items = %s, want %s", body.Items, test.want)
			}
		})
	}

	server.config.Media = mediaService
	response = httptest.NewRecorder()
	server.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/v2/media/tree", nil))
	var folder struct {
		Folders    json.RawMessage `json:"folders"`
		Items      json.RawMessage `json:"items"`
		NextCursor json.RawMessage `json:"nextCursor"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &folder); err != nil {
		t.Fatal(err)
	}
	if response.Code != http.StatusOK || string(folder.Folders) != "[]" || string(folder.Items) != "null" || string(folder.NextCursor) != `"next-token"` {
		t.Fatalf("folder page status=%d folders=%s items=%s cursor=%s body=%s", response.Code, folder.Folders, folder.Items, folder.NextCursor, response.Body.String())
	}

	response = httptest.NewRecorder()
	server.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/v2/media/"+mediaID, nil))
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), "9007199254740993") {
		t.Fatalf("media get status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestImportRefreshHandlersUseTypedJobMapping(t *testing.T) {
	job := librarymedia.ImportJob{
		ID: "j_scanresult1234", State: "running", Progress: 0.5, Indexed: 7,
		RootResults: map[string]librarymedia.RootLibraryStatus{
			"library": {State: librarymedia.LibraryReadyEmpty, ErrorCode: "scan_limit"},
		},
		ErrorCode: "job_failed", ValidationErrors: []string{"safe validation message"},
	}
	server := newTransportTestServer(t, Config{Media: transportTestMedia{}, MediaImport: transportTestImports{job: job}})
	for _, path := range []string{"/api/v2/media/import", "/api/v2/media/refresh", "/api/v2/settings/media/refresh"} {
		t.Run(path, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, path, nil)
			request.Header.Set("Idempotency-Key", "typed-mapping-test")
			response := httptest.NewRecorder()
			server.ServeHTTP(response, request)
			assertImportJobResponse(t, response)
		})
	}

	response := httptest.NewRecorder()
	server.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/v2/media/import/"+job.ID, nil))
	assertImportJobResponse(t, response)
}

func assertImportJobResponse(t *testing.T, response *httptest.ResponseRecorder) {
	t.Helper()
	var got transport.ImportJob
	if response.Code != http.StatusAccepted && response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if err := json.Unmarshal(response.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Id != "j_scanresult1234" || got.State != transport.ImportJobStateRunning || got.Progress != 0.5 || got.Indexed != 7 || got.ErrorCode == nil || *got.ErrorCode != "job_failed" || got.RootResults == nil || (*got.RootResults)["library"].State != transport.ImportJobRootResultsStateReadyEmpty || (*got.RootResults)["library"].ErrorCode == nil || *(*got.RootResults)["library"].ErrorCode != transport.ImportJobRootResultsErrorCodeScanLimit || got.ValidationErrors == nil || len(*got.ValidationErrors) != 1 || (*got.ValidationErrors)[0] != "safe validation message" {
		t.Fatalf("import job transport = %#v", got)
	}
}

func TestDestinationsHandlerUsesTypedTransport(t *testing.T) {
	server := newTransportTestServer(t, Config{
		Media: transportTestMedia{},
		Destinations: []DestinationMetadata{
			{ID: "archive", Label: "Archive", Kind: "archive", Description: "Long-term storage", Retention: "durable"},
			{ID: "download", Label: "Downloads", Kind: "download"},
		},
	})
	response := httptest.NewRecorder()
	server.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/v2/destinations", nil))
	var got transport.DestinationsResponse
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if err := json.Unmarshal(response.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if len(got.Destinations) != 2 || got.Destinations[0].Kind != transport.DestinationKindArchive || got.Destinations[0].Description == nil || *got.Destinations[0].Description != "Long-term storage" || got.Destinations[0].Retention == nil || *got.Destinations[0].Retention != "durable" || got.Destinations[1].Description != nil || got.Destinations[1].Retention != nil {
		t.Fatalf("destinations transport = %#v", got)
	}
}

func TestImportJobTransportOmitsEmptyOptionalFields(t *testing.T) {
	mapped := importJobToTransport(librarymedia.ImportJob{ID: "j_scanresult1234", State: "queued"})
	encoded, err := json.Marshal(mapped)
	if err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{`"rootResults"`, `"errorCode"`, `"validationErrors"`} {
		if strings.Contains(string(encoded), field) {
			t.Fatalf("empty import job field %s was serialized: %s", field, encoded)
		}
	}
}

func TestWaveformHandlerUsesGeneratedTransport(t *testing.T) {
	const mediaID = "m_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	media := librarymedia.Media{ID: mediaID, DurationMS: 1_000, ETag: "etag", Streams: map[string]any{"audio": map[string]any{}}}
	server := newTransportTestServer(t, Config{
		Media:  transportTestMedia{media: media},
		Assets: transportTestAssets{result: AssetResult{StartMS: 10, DurationMS: 50, Peaks: []float64{0.25, 0.75}}},
	})
	response := httptest.NewRecorder()
	server.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/media/v2/media/"+mediaID+"/waveform?startMs=10&durationMs=50&samples=16", nil))
	var got transport.Waveform
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if err := json.Unmarshal(response.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.StartMs != 10 || got.DurationMs != 50 || len(got.Peaks) != 2 || got.Peaks[0] != 0.25 || got.Peaks[1] != 0.75 {
		t.Fatalf("waveform transport = %#v", got)
	}
}
