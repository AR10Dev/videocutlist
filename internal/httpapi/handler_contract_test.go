package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/getkin/kin-openapi/openapi3"
	"github.com/getkin/kin-openapi/openapi3filter"
	"github.com/getkin/kin-openapi/routers"
	"github.com/getkin/kin-openapi/routers/legacy"
	store "videocutlist/internal/db"
	"videocutlist/internal/detection"
	jobqueue "videocutlist/internal/jobs/model"
	"videocutlist/internal/jobs/view"
	librarymedia "videocutlist/internal/library/media"
	"videocutlist/internal/projects"
	"videocutlist/internal/projects/model"
	settingsdomain "videocutlist/internal/settings"
	settingsmodel "videocutlist/internal/settings/model"
)

type handlerContract struct {
	document *openapi3.T
	router   routers.Router
}

func newHandlerContract(t *testing.T) *handlerContract {
	t.Helper()
	loader := openapi3.NewLoader()
	document, err := loader.LoadFromFile(filepath.Join("..", "..", "api", "api.openapi.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	if document.OpenAPI != "3.1.0" {
		t.Fatalf("OpenAPI version = %q, want 3.1.0", document.OpenAPI)
	}
	if err := document.Validate(t.Context()); err != nil {
		t.Fatalf("validate OpenAPI document: %v", err)
	}
	router, err := legacy.NewRouter(document)
	if err != nil {
		t.Fatalf("create OpenAPI router: %v", err)
	}
	return &handlerContract{document: document, router: router}
}

func handlerContractRequest(method, target, body string, headers http.Header) *http.Request {
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	request := httptest.NewRequest(method, target, reader)
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	for name, values := range headers {
		request.Header[name] = append([]string(nil), values...)
	}
	return request
}

func (c *handlerContract) route(t *testing.T, request *http.Request) (*routers.Route, map[string]string) {
	t.Helper()
	route, pathParams, err := c.router.FindRoute(request)
	if err != nil {
		t.Fatalf("find OpenAPI route for %s %s: %v", request.Method, request.URL.Path, err)
	}
	return route, pathParams
}

func (c *handlerContract) requestError(t *testing.T, method, target, body string, headers http.Header) error {
	t.Helper()
	request := handlerContractRequest(method, target, body, headers)
	route, pathParams := c.route(t, request)
	if body != "" {
		if err := c.validateJSONBody(t, route, "request", 0, []byte(body)); err != nil {
			return err
		}
	}
	input := &openapi3filter.RequestValidationInput{
		Request: request, PathParams: pathParams, Route: route,
		Options: &openapi3filter.Options{AuthenticationFunc: openapi3filter.NoopAuthenticationFunc},
	}
	if err := openapi3filter.ValidateRequest(t.Context(), input); err != nil {
		return fmt.Errorf("operation %s: %w", route.Operation.OperationID, err)
	}
	return nil
}

func (c *handlerContract) requireValidRequest(t *testing.T, method, target, body string, headers http.Header) {
	t.Helper()
	if err := c.requestError(t, method, target, body, headers); err != nil {
		t.Fatalf("request does not conform to OpenAPI: %v", err)
	}
}

func (c *handlerContract) requireInvalidRequest(t *testing.T, method, target, body string, headers http.Header) {
	t.Helper()
	if err := c.requestError(t, method, target, body, headers); err == nil {
		t.Fatalf("OpenAPI validator accepted invalid %s %s request body %q", method, target, body)
	}
}

func (c *handlerContract) serve(t *testing.T, handler http.Handler, method, target, body string, headers http.Header) *httptest.ResponseRecorder {
	t.Helper()
	request := handlerContractRequest(method, target, body, headers)
	c.route(t, request)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func requireContractErrorRequestID(t *testing.T, response *httptest.ResponseRecorder) {
	t.Helper()
	var envelope struct {
		Error struct {
			RequestID string `json:"requestId"`
		} `json:"error"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("decode error response: %v", err)
	}
	if requestID := response.Header().Get("X-Request-ID"); requestID == "" || envelope.Error.RequestID != requestID {
		t.Fatalf("error requestId=%q, X-Request-ID=%q", envelope.Error.RequestID, requestID)
	}
}

func (c *handlerContract) responseError(t *testing.T, request *http.Request, response *httptest.ResponseRecorder) error {
	t.Helper()
	route, pathParams := c.route(t, request)
	if len(response.Body.Bytes()) != 0 {
		if err := c.validateJSONBody(t, route, "response", response.Code, response.Body.Bytes()); err != nil {
			return err
		}
	}
	input := &openapi3filter.RequestValidationInput{Request: request, PathParams: pathParams, Route: route}
	responseInput := &openapi3filter.ResponseValidationInput{
		RequestValidationInput: input,
		Status:                 response.Code,
		Header:                 response.Header(),
		Body:                   io.NopCloser(bytes.NewReader(response.Body.Bytes())),
		Options:                &openapi3filter.Options{IncludeResponseStatus: true},
	}
	if err := openapi3filter.ValidateResponse(t.Context(), responseInput); err != nil {
		return fmt.Errorf("operation %s status %d: %w", route.Operation.OperationID, response.Code, err)
	}
	return nil
}

func (c *handlerContract) requireValidResponse(t *testing.T, request *http.Request, response *httptest.ResponseRecorder) {
	t.Helper()
	if err := c.responseError(t, request, response); err != nil {
		t.Fatalf("handler response does not conform to OpenAPI: %v; body=%s", err, response.Body.String())
	}
}

func newHandlerContractServer(t *testing.T, config Config) *Server {
	t.Helper()
	authenticator, err := NewAuthenticator(AuthConfig{Mode: "none"})
	if err != nil {
		t.Fatal(err)
	}
	config.Authenticator = authenticator
	if config.Media == nil {
		config.Media = &routeTestMedia{}
	}
	if config.Preview == nil {
		config.Preview = routeTestPreview{}
	}
	if config.Projects == nil {
		config.Projects = routeTestProjects{}
	}
	if config.BatchExports == nil {
		config.BatchExports = &routeTestBatchExports{}
	}
	if config.Jobs == nil {
		config.Jobs = &routeTestJobs{}
	}
	server, err := New(config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(server.Shutdown)
	return server
}

type handlerContractProjects struct {
	routeTestProjects
	project   projects.Project
	page      projects.ProjectPage
	listLimit int
	saveErr   error
	saved     *projects.ProjectInput
}

func (s *handlerContractProjects) Get(context.Context, string) (projects.Project, error) {
	return s.project, nil
}

func (s *handlerContractProjects) Save(_ context.Context, id string, input projects.ProjectInput) (projects.Project, error) {
	s.saved = &input
	if s.saveErr != nil {
		return projects.Project{}, s.saveErr
	}
	return projects.Project{
		Document: input.Document, ID: id, Revision: input.Revision + 1,
		UpdatedAt: time.Date(2025, 1, 2, 3, 4, 5, 0, time.UTC),
	}, nil
}

func (s *handlerContractProjects) List(_ context.Context, _ string, limit int) (projects.ProjectPage, error) {
	s.listLimit = limit
	return s.page, nil
}

func handlerContractProject(id string, options model.ExportOptions) projects.Project {
	return projects.Project{
		Document: model.Document{SchemaVersion: 2, Name: "Contract project", Items: []model.ProjectItem{{
			ID: "i_" + strings.Repeat("a", 24), MediaID: "m_" + strings.Repeat("b", 43),
			Segments: []model.Segment{{StartMS: 0, EndMS: 100}}, ExportOptions: options,
		}}},
		ID: id, Revision: 7, UpdatedAt: time.Date(2025, 1, 2, 3, 4, 5, 0, time.UTC),
	}
}

func TestHandlerContractProjectsAndProjectListDefaults(t *testing.T) {
	contract := newHandlerContract(t)
	projectID := "p_" + strings.Repeat("a", 12)
	options := model.ExportOptions{StreamIndexes: []int{}}
	projectsService := &handlerContractProjects{
		project: handlerContractProject(projectID, options),
		page:    projects.ProjectPage{Items: []projects.ProjectSummary{}, NextCursor: nil},
	}
	server := newHandlerContractServer(t, Config{Projects: projectsService})

	getPath := "/api/v2/projects/" + projectID
	contract.requireValidRequest(t, http.MethodGet, getPath, "", nil)
	getRequest := handlerContractRequest(http.MethodGet, getPath, "", nil)
	getResponse := contract.serve(t, server, http.MethodGet, getPath, "", nil)
	if getResponse.Code != http.StatusOK {
		t.Fatalf("GET project status=%d body=%s", getResponse.Code, getResponse.Body.String())
	}
	contract.requireValidResponse(t, getRequest, getResponse)
	var projectBody struct {
		Items []struct {
			ExportOptions json.RawMessage `json:"exportOptions"`
			Segments      []struct {
				Included *bool `json:"included"`
			} `json:"segments"`
		} `json:"items"`
	}
	if err := json.Unmarshal(getResponse.Body.Bytes(), &projectBody); err != nil {
		t.Fatal(err)
	}
	if len(projectBody.Items) != 1 || len(projectBody.Items[0].Segments) != 1 || projectBody.Items[0].Segments[0].Included == nil || !*projectBody.Items[0].Segments[0].Included || len(projectBody.Items[0].ExportOptions) == 0 {
		t.Fatalf("GET project did not preserve optional default/required export options: %s", getResponse.Body.String())
	}

	putBody := `{"revision":6,"schemaVersion":2,"name":"Updated","items":[{"id":"i_aaaaaaaaaaaaaaaaaaaaaaaa","mediaId":"m_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","segments":[{"startMs":0,"endMs":100}],"exportOptions":{"streamIndexes":[]}}]}`
	contract.requireValidRequest(t, http.MethodPut, getPath, putBody, nil)
	putRequest := handlerContractRequest(http.MethodPut, getPath, putBody, nil)
	putResponse := contract.serve(t, server, http.MethodPut, getPath, putBody, nil)
	if putResponse.Code != http.StatusOK || projectsService.saved == nil {
		t.Fatalf("PUT project status=%d saved=%v body=%s", putResponse.Code, projectsService.saved != nil, putResponse.Body.String())
	}
	contract.requireValidResponse(t, putRequest, putResponse)
	if got := projectsService.saved.Document.Items[0].Segments[0].IsIncluded(); !got {
		t.Fatalf("omitted segment included default = %t, want true", got)
	}
	contract.requireInvalidRequest(t, http.MethodPut, getPath, strings.Replace(putBody, `"name":"Updated"`, `"name":null`, 1), nil)
	for _, invalid := range []struct {
		name string
		body string
	}{
		{name: "wrong primitive type", body: strings.Replace(putBody, `"revision":6`, `"revision":"6"`, 1)},
		{name: "ordinary fractional integer", body: strings.Replace(putBody, `"revision":6`, `"revision":6.5`, 1)},
		{name: "fractional integer precision", body: strings.Replace(putBody, `"revision":6`, `"revision":6.0000000000000001`, 1)},
		{name: "unknown top-level field", body: strings.Replace(putBody, `{`, `{"unknown":true,`, 1)},
		{name: "unknown nested field", body: strings.Replace(putBody, `"endMs":100`, `"endMs":100,"unknown":true`, 1)},
		{name: "second JSON value", body: putBody + ` {}`},
		{name: "trailing garbage", body: putBody + ` trailing`},
	} {
		t.Run(invalid.name, func(t *testing.T) {
			contract.requireInvalidRequest(t, http.MethodPut, getPath, invalid.body, nil)
			invalidRequest := handlerContractRequest(http.MethodPut, getPath, invalid.body, nil)
			savedBefore := projectsService.saved
			response := contract.serve(t, server, http.MethodPut, getPath, invalid.body, nil)
			if response.Code != http.StatusBadRequest || projectsService.saved != savedBefore {
				t.Fatalf("invalid project status=%d service invoked=%t body=%s", response.Code, projectsService.saved != savedBefore, response.Body.String())
			}
			contract.requireValidResponse(t, invalidRequest, response)
			requireContractErrorRequestID(t, response)
		})
	}

	listPath := "/api/v2/projects"
	contract.requireValidRequest(t, http.MethodGet, listPath, "", nil)
	listRequest := handlerContractRequest(http.MethodGet, listPath, "", nil)
	listResponse := contract.serve(t, server, http.MethodGet, listPath, "", nil)
	if listResponse.Code != http.StatusOK || projectsService.listLimit != 50 {
		t.Fatalf("GET project list status=%d default limit=%d body=%s", listResponse.Code, projectsService.listLimit, listResponse.Body.String())
	}
	contract.requireValidResponse(t, listRequest, listResponse)
	if !strings.Contains(listResponse.Body.String(), `"nextCursor":null`) {
		t.Fatalf("nullable project cursor was not serialized: %s", listResponse.Body.String())
	}

	// Preserve and identify the approved zero-value wire exception: the current
	// handler omits exportOptions although Project requires the property.
	projectsService.project = handlerContractProject(projectID, model.ExportOptions{})
	getRequest = handlerContractRequest(http.MethodGet, getPath, "", nil)
	getResponse = contract.serve(t, server, http.MethodGet, getPath, "", nil)
	if getResponse.Code != http.StatusOK || strings.Contains(getResponse.Body.String(), `"exportOptions"`) {
		t.Fatalf("zero exportOptions legacy branch changed: status=%d body=%s", getResponse.Code, getResponse.Body.String())
	}
	if err := contract.responseError(t, getRequest, getResponse); err == nil {
		t.Fatal("OpenAPI validator accepted the known zero exportOptions mismatch")
	}

	invalidBody := `{"revision":6,"schemaVersion":2,"name":"Empty","items":[]}`
	contract.requireInvalidRequest(t, http.MethodPut, getPath, invalidBody, nil)
	projectsService.saveErr = projects.ErrInvalidProject
	invalidRequest := handlerContractRequest(http.MethodPut, getPath, invalidBody, nil)
	invalidResponse := contract.serve(t, server, http.MethodPut, getPath, invalidBody, nil)
	if invalidResponse.Code != http.StatusBadRequest {
		t.Fatalf("invalid project status=%d body=%s", invalidResponse.Code, invalidResponse.Body.String())
	}
	contract.requireValidResponse(t, invalidRequest, invalidResponse)
}

func TestHandlerContractRejectsUnknownLengthOversizedProjectBody(t *testing.T) {
	contract := newHandlerContract(t)
	projectID := "p_" + strings.Repeat("a", 12)
	projectsService := &handlerContractProjects{project: handlerContractProject(projectID, model.ExportOptions{StreamIndexes: []int{}})}
	server := newHandlerContractServer(t, Config{Projects: projectsService})
	request := httptest.NewRequest(http.MethodPut, "/api/v2/projects/"+projectID, strings.NewReader(strings.Repeat(" ", MaxJSONBody+1)))
	request.Header.Set("Content-Type", "application/json")
	request.ContentLength = -1
	contract.route(t, request)
	savedBefore := projectsService.saved
	response := httptest.NewRecorder()
	server.ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest || projectsService.saved != savedBefore {
		t.Fatalf("oversized unknown-length body status=%d service invoked=%t body=%s", response.Code, projectsService.saved != savedBefore, response.Body.String())
	}
	contract.requireValidResponse(t, request, response)
	requireContractErrorRequestID(t, response)
}

func handlerContractSettings() settingsmodel.RuntimeSettings {
	return settingsmodel.RuntimeSettings{
		MediaRoots: map[string]string{"contract": "/media/contract"},
		Destinations: []settingsmodel.RuntimeDestination{{
			ID: "download", Label: "Downloads", Kind: "download", Root: "/exports", Retention: "24h",
		}},
		ExportLimit: 2, CacheMaxBytes: 1024, PreviewGlobalLimit: 2,
		PreviewBeforeMS: 100, PreviewAfterMS: 100, PreviewMaxMS: 1000, PreviewGridMS: 100,
		MediaMaxFiles: 20, MediaMaxDepth: 4, MCPEnabled: false,
	}
}

func handlerContractSettingsUpdate(t *testing.T, revision int64, settings settingsmodel.RuntimeSettings, includeMediaRoots bool) string {
	t.Helper()
	mutableSettings := map[string]any{
		"exportLimit": settings.ExportLimit, "cacheMaxBytes": settings.CacheMaxBytes,
		"previewGlobalLimit": settings.PreviewGlobalLimit, "previewBeforeMs": settings.PreviewBeforeMS,
		"previewAfterMs": settings.PreviewAfterMS, "previewMaxMs": settings.PreviewMaxMS,
		"previewGridMs": settings.PreviewGridMS, "mediaMaxFiles": settings.MediaMaxFiles,
		"mediaMaxDepth": settings.MediaMaxDepth, "mcpEnabled": settings.MCPEnabled,
	}
	if includeMediaRoots {
		mutableSettings["mediaRoots"] = settings.MediaRoots
	}
	body, err := json.Marshal(map[string]any{"revision": revision, "settings": mutableSettings})
	if err != nil {
		t.Fatal(err)
	}
	return string(body)
}

func TestHandlerContractSettingsAndPathEchoException(t *testing.T) {
	contract := newHandlerContract(t)
	database, err := store.OpenDatabase(t.Context(), filepath.Join(t.TempDir(), "settings.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := database.Close(); err != nil {
			t.Error(err)
		}
	})
	repository, err := store.NewRuntimeSettingsStore(database)
	if err != nil {
		t.Fatal(err)
	}
	initial, err := repository.Seed(t.Context(), handlerContractSettings())
	if err != nil {
		t.Fatal(err)
	}
	service := settingsdomain.NewRuntimeService(repository, settingsmodel.NewRuntimeSettingsState(initial.Settings), nil)
	server := newHandlerContractServer(t, Config{Settings: service})

	getPath := "/api/v2/settings"
	contract.requireValidRequest(t, http.MethodGet, getPath, "", nil)
	getRequest := handlerContractRequest(http.MethodGet, getPath, "", nil)
	getResponse := contract.serve(t, server, http.MethodGet, getPath, "", nil)
	if getResponse.Code != http.StatusOK {
		t.Fatalf("GET settings status=%d body=%s", getResponse.Code, getResponse.Body.String())
	}
	contract.requireValidResponse(t, getRequest, getResponse)

	current, err := repository.Get(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	validBody := handlerContractSettingsUpdate(t, current.Revision, current.Settings, false)
	contract.requireValidRequest(t, http.MethodPut, getPath, validBody, nil)
	validRequest := handlerContractRequest(http.MethodPut, getPath, validBody, nil)
	validResponse := contract.serve(t, server, http.MethodPut, getPath, validBody, nil)
	if validResponse.Code != http.StatusOK {
		t.Fatalf("PUT settings status=%d body=%s", validResponse.Code, validResponse.Body.String())
	}
	contract.requireValidResponse(t, validRequest, validResponse)

	for _, exportLimit := range []int{0, 65} {
		current, err = repository.Get(t.Context())
		if err != nil {
			t.Fatal(err)
		}
		invalidSettings := current.Settings
		invalidSettings.ExportLimit = exportLimit
		invalidBody := handlerContractSettingsUpdate(t, current.Revision, invalidSettings, false)
		contract.requireInvalidRequest(t, http.MethodPut, getPath, invalidBody, nil)
		invalidRequest := handlerContractRequest(http.MethodPut, getPath, invalidBody, nil)
		invalidResponse := contract.serve(t, server, http.MethodPut, getPath, invalidBody, nil)
		if invalidResponse.Code != http.StatusBadRequest {
			t.Fatalf("out-of-range exportLimit=%d status=%d body=%s", exportLimit, invalidResponse.Code, invalidResponse.Body.String())
		}
		contract.requireValidResponse(t, invalidRequest, invalidResponse)
		requireContractErrorRequestID(t, invalidResponse)
		unchanged, err := repository.Get(t.Context())
		if err != nil {
			t.Fatal(err)
		}
		if unchanged.Revision != current.Revision || unchanged.Settings.ExportLimit != current.Settings.ExportLimit {
			t.Fatalf("rejected exportLimit=%d mutated settings: before revision=%d limit=%d, after revision=%d limit=%d", exportLimit, current.Revision, current.Settings.ExportLimit, unchanged.Revision, unchanged.Settings.ExportLimit)
		}
	}

	// The custom settings decoder still accepts an unchanged echoed media path;
	// the OpenAPI SettingsUpdate schema deliberately does not describe this echo.
	current, err = repository.Get(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	echoBody := handlerContractSettingsUpdate(t, current.Revision, current.Settings, true)
	contract.requireInvalidRequest(t, http.MethodPut, getPath, echoBody, nil)
	echoRequest := handlerContractRequest(http.MethodPut, getPath, echoBody, nil)
	echoResponse := contract.serve(t, server, http.MethodPut, getPath, echoBody, nil)
	if echoResponse.Code != http.StatusOK {
		t.Fatalf("unchanged path echo status=%d body=%s", echoResponse.Code, echoResponse.Body.String())
	}
	contract.requireValidResponse(t, echoRequest, echoResponse)
	if strings.Contains(echoResponse.Body.String(), "/media/contract") {
		t.Fatalf("settings response exposed deployment path: %s", echoResponse.Body.String())
	}
}

type handlerContractMedia struct {
	routeTestMedia
	status librarymedia.LibraryStatus
}

func (m *handlerContractMedia) Status() librarymedia.LibraryStatus { return m.status }

func TestHandlerContractLibraryAndJobAdditionalData(t *testing.T) {
	contract := newHandlerContract(t)
	media := &handlerContractMedia{status: librarymedia.LibraryStatus{
		State: librarymedia.LibraryReadyWithMedia, Message: "Ready",
		Roots: map[string]librarymedia.RootLibraryStatus{"root_contract": {State: librarymedia.LibraryReadyEmpty}},
	}}
	server := newHandlerContractServer(t, Config{Media: media})
	statusPath := "/api/v2/media/status"
	contract.requireValidRequest(t, http.MethodGet, statusPath, "", nil)
	statusRequest := handlerContractRequest(http.MethodGet, statusPath, "", nil)
	statusResponse := contract.serve(t, server, http.MethodGet, statusPath, "", nil)
	if statusResponse.Code != http.StatusOK {
		t.Fatalf("GET library status=%d body=%s", statusResponse.Code, statusResponse.Body.String())
	}
	contract.requireValidResponse(t, statusRequest, statusResponse)
	if !strings.Contains(statusResponse.Body.String(), `"roots":{"root_contract"`) {
		t.Fatalf("library root diagnostics were dropped: %s", statusResponse.Body.String())
	}

	jobID := "j_" + strings.Repeat("c", 12)
	now := time.Date(2025, 1, 2, 3, 4, 5, 0, time.UTC)
	point := int64(42)
	job := view.Job{
		ID: jobID, Type: "detection", State: "succeeded", Revision: 1, Progress: 1,
		CreatedAt: now, UpdatedAt: now,
		RootResults: map[string]librarymedia.RootLibraryStatus{"root_contract": {State: librarymedia.LibraryReadyEmpty}},
		Candidates: []model.Candidate{{
			ID: "c_contract", MediaID: "m_" + strings.Repeat("d", 43), ProjectID: "p_" + strings.Repeat("e", 12),
			ProjectRevision: 7, PointMS: &point, Source: model.DetectScene,
		}},
	}
	jobs := &contractJobService{job: job}
	server = newHandlerContractServer(t, Config{Jobs: jobs})
	jobPath := "/api/v2/jobs/" + jobID
	contract.requireValidRequest(t, http.MethodGet, jobPath, "", nil)
	jobRequest := handlerContractRequest(http.MethodGet, jobPath, "", nil)
	jobResponse := contract.serve(t, server, http.MethodGet, jobPath, "", nil)
	if jobResponse.Code != http.StatusOK {
		t.Fatalf("GET job status=%d body=%s", jobResponse.Code, jobResponse.Body.String())
	}
	contract.requireValidResponse(t, jobRequest, jobResponse)
	if !strings.Contains(jobResponse.Body.String(), `"rootResults"`) || !strings.Contains(jobResponse.Body.String(), `"candidates"`) {
		t.Fatalf("additional job data was dropped: %s", jobResponse.Body.String())
	}

	missingJobs := &contractJobService{getErr: jobqueue.ErrJobNotFound}
	server = newHandlerContractServer(t, Config{Jobs: missingJobs})
	contract.requireValidRequest(t, http.MethodGet, jobPath, "", nil)
	errorRequest := handlerContractRequest(http.MethodGet, jobPath, "", nil)
	errorResponse := contract.serve(t, server, http.MethodGet, jobPath, "", nil)
	if errorResponse.Code != http.StatusNotFound {
		t.Fatalf("missing job status=%d body=%s", errorResponse.Code, errorResponse.Body.String())
	}
	contract.requireValidResponse(t, errorRequest, errorResponse)
}

func TestHandlerContractDetectionUnionAndLegacyFallback(t *testing.T) {
	contract := newHandlerContract(t)
	projectID := "p_" + strings.Repeat("f", 12)
	mediaID := "m_" + strings.Repeat("g", 43)
	itemID := "i_" + strings.Repeat("h", 24)
	point := int64(250)
	service := &contractDetectionService{job: detection.Job{
		ID: "j_detection1234", Type: "detection", State: "succeeded", MediaID: mediaID,
		ProjectID: projectID, ProjectRevision: 7, Kind: model.DetectSilence,
		Candidates: []model.Candidate{
			{ID: "c_range", MediaID: mediaID, ProjectID: projectID, ProjectRevision: 7, StartMS: 100, EndMS: 200, Source: model.DetectSilence},
			{ID: "c_point", MediaID: mediaID, ProjectID: projectID, ProjectRevision: 7, PointMS: &point, Source: model.DetectScene},
		},
	}}
	server := newHandlerContractServer(t, Config{Detection: service})
	path := "/api/v2/projects/" + projectID + "/detections"
	body := fmt.Sprintf(`{"mediaId":%q,"projectItemId":%q,"projectRevision":7,"kind":"silence"}`, mediaID, itemID)
	headers := http.Header{"Idempotency-Key": []string{"contract-detection"}}
	contract.requireValidRequest(t, http.MethodPost, path, body, headers)
	request := handlerContractRequest(http.MethodPost, path, body, headers)
	response := contract.serve(t, server, http.MethodPost, path, body, headers)
	if response.Code != http.StatusAccepted {
		t.Fatalf("create detection status=%d body=%s", response.Code, response.Body.String())
	}
	contract.requireValidResponse(t, request, response)

	for _, invalid := range []struct {
		name string
		body string
	}{
		{name: "malformed JSON", body: "{"},
		{name: "invalid enum", body: fmt.Sprintf(`{"mediaId":%q,"projectItemId":%q,"projectRevision":7,"kind":"unknown"}`, mediaID, itemID)},
		{name: "missing required revision", body: fmt.Sprintf(`{"mediaId":%q,"projectItemId":%q,"kind":"silence"}`, mediaID, itemID)},
		{name: "scene threshold above maximum", body: fmt.Sprintf(`{"mediaId":%q,"projectItemId":%q,"projectRevision":7,"kind":"scene","sceneThreshold":1.01}`, mediaID, itemID)},
	} {
		t.Run(invalid.name, func(t *testing.T) {
			contract.requireInvalidRequest(t, http.MethodPost, path, invalid.body, headers)
			invalidRequest := handlerContractRequest(http.MethodPost, path, invalid.body, headers)
			invalidResponse := contract.serve(t, server, http.MethodPost, path, invalid.body, headers)
			if invalidResponse.Code != http.StatusBadRequest {
				t.Fatalf("invalid detection status=%d body=%s", invalidResponse.Code, invalidResponse.Body.String())
			}
			contract.requireValidResponse(t, invalidRequest, invalidResponse)
			requireContractErrorRequestID(t, invalidResponse)
		})
	}
	if service.creates != 1 {
		t.Fatalf("detection submissions after invalid requests=%d, want 1", service.creates)
	}

	// The legacy scene candidate has no pointMs and still uses the preserved
	// domain-wide response fallback; its candidate does not match DetectionCandidate.
	legacyService := &contractDetectionService{job: detection.Job{
		ID: "j_legacy123456", Type: "detection", State: "succeeded", MediaID: mediaID,
		ProjectID: projectID, ProjectRevision: 7, Kind: model.DetectScene,
		Candidates: []model.Candidate{{
			ID: "c_legacy", MediaID: mediaID, ProjectID: projectID, ProjectRevision: 7,
			StartMS: 100, EndMS: 200, Source: model.DetectScene,
		}},
	}}
	legacyServer := newHandlerContractServer(t, Config{Detection: legacyService})
	legacyBody := fmt.Sprintf(`{"mediaId":%q,"projectItemId":%q,"projectRevision":7,"kind":"scene"}`, mediaID, itemID)
	contract.requireValidRequest(t, http.MethodPost, path, legacyBody, headers)
	legacyRequest := handlerContractRequest(http.MethodPost, path, legacyBody, headers)
	legacyResponse := contract.serve(t, legacyServer, http.MethodPost, path, legacyBody, headers)
	if legacyResponse.Code != http.StatusAccepted || strings.Contains(legacyResponse.Body.String(), `"pointMs"`) {
		t.Fatalf("legacy scene fallback changed: status=%d body=%s", legacyResponse.Code, legacyResponse.Body.String())
	}
	if err := contract.responseError(t, legacyRequest, legacyResponse); err == nil {
		t.Fatal("OpenAPI validator accepted the known legacy detection fallback mismatch")
	}
}

func TestHandlerContractExportSuccessAndInvalidRequests(t *testing.T) {
	contract := newHandlerContract(t)
	projectID := "p_" + strings.Repeat("i", 12)
	jobID := "j_" + strings.Repeat("j", 12)
	now := time.Date(2025, 1, 2, 3, 4, 5, 0, time.UTC)
	batch := &contractBatchService{submitted: []view.Job{{
		ID: jobID, Type: "export", State: "queued", Revision: 1, CreatedAt: now, UpdatedAt: now,
	}}}
	server := newHandlerContractServer(t, Config{BatchExports: batch})
	path := "/api/v2/projects/" + projectID + "/exports"
	body := `{"projectRevision":7,"itemIds":["i_aaaaaaaaaaaaaaaaaaaaaaaa"]}`
	headers := http.Header{"Idempotency-Key": []string{"contract-export"}}
	contract.requireValidRequest(t, http.MethodPost, path, body, headers)
	request := handlerContractRequest(http.MethodPost, path, body, headers)
	response := contract.serve(t, server, http.MethodPost, path, body, headers)
	if response.Code != http.StatusAccepted {
		t.Fatalf("create export status=%d body=%s", response.Code, response.Body.String())
	}
	contract.requireValidResponse(t, request, response)

	invalidBody := `{"projectRevision":0}`
	contract.requireInvalidRequest(t, http.MethodPost, path, invalidBody, headers)
	invalidRequest := handlerContractRequest(http.MethodPost, path, invalidBody, headers)
	invalidResponse := contract.serve(t, server, http.MethodPost, path, invalidBody, headers)
	if invalidResponse.Code != http.StatusBadRequest {
		t.Fatalf("invalid export status=%d body=%s", invalidResponse.Code, invalidResponse.Body.String())
	}
	contract.requireValidResponse(t, invalidRequest, invalidResponse)
	if batch.submits != 1 {
		t.Fatalf("export submissions after invalid request=%d, want 1", batch.submits)
	}
}

func TestHandlerContractNegativeControls(t *testing.T) {
	contract := newHandlerContract(t)
	path := "/api/v2/projects/p_" + strings.Repeat("k", 12)
	contract.requireValidRequest(t, http.MethodGet, path, "", nil)
	request := handlerContractRequest(http.MethodGet, path, "", nil)
	mismatch := httptest.NewRecorder()
	mismatch.Header().Set("Content-Type", "application/json")
	mismatch.WriteHeader(http.StatusOK)
	_, _ = mismatch.Write([]byte(`{"deliberateMismatch":true}`))
	if err := contract.responseError(t, request, mismatch); err == nil {
		t.Fatal("OpenAPI validator accepted deliberate response mismatch")
	}
	undocumentedStatus := httptest.NewRecorder()
	undocumentedStatus.WriteHeader(http.StatusTeapot)
	if err := contract.responseError(t, request, undocumentedStatus); err == nil {
		t.Fatal("OpenAPI validator accepted undocumented response status")
	}

	// Invalid input must be rejected by both the request validator and the real
	// handler, whose safe error envelope is itself checked against the operation.
	projectID := "p_" + strings.Repeat("l", 12)
	mediaID := "m_" + strings.Repeat("m", 43)
	invalidBody := fmt.Sprintf(`{"mediaId":%q,"projectItemId":"i_%s","projectRevision":1,"kind":"invalid"}`, mediaID, strings.Repeat("n", 24))
	invalidPath := "/api/v2/projects/" + projectID + "/detections"
	headers := http.Header{"Idempotency-Key": []string{"invalid-control"}}
	contract.requireInvalidRequest(t, http.MethodPost, invalidPath, invalidBody, headers)
	server := newHandlerContractServer(t, Config{Detection: &contractDetectionService{}})
	invalidRequest := handlerContractRequest(http.MethodPost, invalidPath, invalidBody, headers)
	response := contract.serve(t, server, http.MethodPost, invalidPath, invalidBody, headers)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("invalid request handler status=%d body=%s", response.Code, response.Body.String())
	}
	contract.requireValidResponse(t, invalidRequest, response)
}

func TestHandlerContractExactNumbersAndSingleJSONValue(t *testing.T) {
	contract := newHandlerContract(t)
	projectID := "p_" + strings.Repeat("a", 12)
	projectPath := "/api/v2/projects/" + projectID
	itemID := "i_" + strings.Repeat("b", 24)
	mediaID := "m_" + strings.Repeat("c", 43)
	projectBody := fmt.Sprintf(`{"revision":6,"schemaVersion":2,"name":"Contract","items":[{"id":%q,"mediaId":%q,"segments":[],"exportOptions":{}}]}`, itemID, mediaID)
	if err := contract.requestError(t, http.MethodPut, projectPath, projectBody, nil); err != nil {
		t.Fatalf("valid project request rejected: %v", err)
	}
	for _, invalid := range []struct {
		name string
		body string
	}{
		{name: "fractional integer precision", body: strings.Replace(projectBody, `"revision":6`, `"revision":6.0000000000000001`, 1)},
		{name: "second JSON value", body: projectBody + ` {}`},
		{name: "trailing garbage", body: projectBody + ` trailing`},
		{name: "wrong primitive type", body: strings.Replace(projectBody, `"revision":6`, `"revision":"6"`, 1)},
		{name: "nonnullable null", body: strings.Replace(projectBody, `"name":"Contract"`, `"name":null`, 1)},
		{name: "revision below minimum", body: strings.Replace(projectBody, `"revision":6`, `"revision":-1`, 1)},
	} {
		t.Run("request/"+invalid.name, func(t *testing.T) {
			if err := contract.requestError(t, http.MethodPut, projectPath, invalid.body, nil); err == nil {
				t.Errorf("accepted invalid project request %q", invalid.body)
			}
		})
	}

	settingsPath := "/api/v2/settings"
	settingsBody := handlerContractSettingsUpdate(t, 1, handlerContractSettings(), false)
	if err := contract.requestError(t, http.MethodPut, settingsPath, settingsBody, nil); err != nil {
		t.Fatalf("valid settings request rejected: %v", err)
	}
	preciseSettingsBody := strings.Replace(settingsBody, `"exportLimit":2`, `"exportLimit":64.000000000000001`, 1)
	if err := contract.requestError(t, http.MethodPut, settingsPath, preciseSettingsBody, nil); err == nil {
		t.Fatal("accepted fractional settings exportLimit beyond integer boundary")
	}

	getRequest := handlerContractRequest(http.MethodGet, projectPath, "", nil)
	projectResponse := fmt.Sprintf(`{"id":%q,"updatedAt":"2025-01-02T03:04:05Z","revision":7,"schemaVersion":2,"name":"Contract","items":[{"id":%q,"mediaId":%q,"segments":[],"exportOptions":{}}]}`, projectID, itemID, mediaID)
	validProjectResponse := httptest.NewRecorder()
	validProjectResponse.Header().Set("Content-Type", "application/json")
	validProjectResponse.WriteHeader(http.StatusOK)
	if _, err := validProjectResponse.Write([]byte(projectResponse)); err != nil {
		t.Fatal(err)
	}
	if err := contract.responseError(t, getRequest, validProjectResponse); err != nil {
		t.Fatalf("valid project response rejected: %v", err)
	}
	for _, invalid := range []struct {
		name string
		body string
	}{
		{name: "fractional integer precision", body: strings.Replace(projectResponse, `"revision":7`, `"revision":7.0000000000000001`, 1)},
		{name: "second JSON value", body: projectResponse + ` {}`},
		{name: "trailing garbage", body: projectResponse + ` trailing`},
		{name: "wrong primitive type", body: strings.Replace(projectResponse, `"id":"`+projectID+`"`, `"id":7`, 1)},
		{name: "nonnullable null", body: strings.Replace(projectResponse, `"updatedAt":"2025-01-02T03:04:05Z"`, `"updatedAt":null`, 1)},
		{name: "revision below minimum", body: strings.Replace(projectResponse, `"revision":7`, `"revision":0`, 1)},
	} {
		t.Run("response/"+invalid.name, func(t *testing.T) {
			response := httptest.NewRecorder()
			response.Header().Set("Content-Type", "application/json")
			response.WriteHeader(http.StatusOK)
			if _, err := response.Write([]byte(invalid.body)); err != nil {
				t.Fatal(err)
			}
			if err := contract.responseError(t, getRequest, response); err == nil {
				t.Errorf("accepted invalid project response %q", invalid.body)
			}
		})
	}
}

func TestHandlerContractOpenAPI31KeywordProbes(t *testing.T) {
	contract := newHandlerContract(t)
	options := []openapi3.SchemaValidationOption{openapi3.EnableJSONSchema2020()}
	projectPayload := map[string]any{
		"revision": int64(1), "schemaVersion": int64(2), "name": "Contract", "items": []any{
			map[string]any{
				"id": "i_" + strings.Repeat("a", 24), "mediaId": "m_" + strings.Repeat("b", 43),
				"segments": []any{}, "exportOptions": map[string]any{},
			},
		},
	}
	projectInput := contract.document.Components.Schemas["ProjectInput"].Value
	if err := projectInput.VisitJSON(projectPayload, options...); err != nil {
		t.Fatalf("OpenAPI 3.1 valid ProjectInput rejected: %v", err)
	}
	projectPayload["schemaVersion"] = 3
	if err := projectInput.VisitJSON(projectPayload, options...); err == nil {
		t.Fatal("OpenAPI 3.1 const keyword was not enforced")
	}
	delete(projectPayload, "schemaVersion")
	if err := projectInput.VisitJSON(projectPayload, options...); err == nil {
		t.Fatal("required ProjectInput field was not enforced")
	}

	cursor := contract.document.Components.Schemas["ProjectPage"].Value.Properties["nextCursor"].Value
	if err := cursor.VisitJSON(nil, options...); err != nil {
		t.Fatalf("OpenAPI 3.1 nullable type array rejected null: %v", err)
	}

	invalidLimit := contract.document.Components.Schemas["RuntimeSettings"].Value.Properties["exportLimit"].Value
	if err := invalidLimit.VisitJSON(0, options...); err == nil {
		t.Fatal("integer minimum was not enforced")
	}

	kind := contract.document.Components.Schemas["DetectionInput"].Value.Properties["kind"].Value
	if err := kind.VisitJSON("unknown", options...); err == nil {
		t.Fatal("enum keyword was not enforced")
	}
	threshold := contract.document.Components.Schemas["DetectionInput"].Value.Properties["sceneThreshold"].Value
	if err := threshold.VisitJSON(1.01, options...); err == nil {
		t.Fatal("maximum keyword was not enforced")
	}
	zoom := contract.document.Components.Schemas["UIState"].Value.Properties["zoom"].Value
	if err := zoom.VisitJSON(0, options...); err == nil {
		t.Fatal("exclusiveMinimum keyword was not enforced")
	}

	candidate := contract.document.Components.Schemas["DetectionCandidate"].Value
	invalidUnion := map[string]any{
		"id": "c_invalid", "mediaId": "m_contract", "projectId": "p_contract", "projectRevision": 1,
		"startMs": 100, "endMs": 200, "source": "scene",
	}
	if err := candidate.VisitJSON(invalidUnion, options...); err == nil {
		t.Fatal("oneOf rejected no candidate: invalid branch was accepted")
	}
}
