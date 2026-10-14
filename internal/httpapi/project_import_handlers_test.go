package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"videocutlist/internal/library/media"
	"videocutlist/internal/library/media/index"
	"videocutlist/internal/preview"
	"videocutlist/internal/projects"
)

const (
	httpImportMediaID = "m_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	httpImportItemID  = "i_aaaaaaaaaaaaaaaaaaaaaaaa"
)

func TestProjectImportHandlerRouteConformsToOpenAPI(t *testing.T) {
	contract := newHandlerContract(t)
	server := newHandlerContractServer(t, Config{ProjectImports: projects.ProjectUseCase{Media: httpProjectImportCatalog{}}})
	name120 := strings.Repeat("雪", 120)
	name121 := strings.Repeat("雪", 121)
	v2Content := func(name string) string {
		encodedName, err := json.Marshal(name)
		if err != nil {
			t.Fatal(err)
		}
		return `{"schemaVersion":2,"name":` + string(encodedName) + `,"items":[{"id":"` + httpImportItemID + `","mediaId":"` + httpImportMediaID + `","segments":[{"startMs":0,"endMs":100}]}]}`
	}
	tests := []struct {
		name         string
		content      string
		status       int
		sourceFormat string
		mediaID      string
		documentName string
	}{
		{
			name:         "legacy result returns selected media ID",
			content:      `{"mediaId":"` + httpImportMediaID + `","segments":[{"startMs":0,"endMs":100}],"uiState":{}}`,
			status:       http.StatusOK,
			sourceFormat: "legacy",
			mediaID:      httpImportMediaID,
			documentName: "Imported cut list",
		},
		{name: "120 Unicode code-point name", content: v2Content(name120), status: http.StatusOK, sourceFormat: "v2", documentName: name120},
		{name: "121 Unicode code-point name", content: v2Content(name121), status: http.StatusBadRequest},
	}
	const target = "/api/v2/projects/import"
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			bodyBytes, err := json.Marshal(map[string]string{"content": test.content})
			if err != nil {
				t.Fatal(err)
			}
			body := string(bodyBytes)
			contract.requireValidRequest(t, http.MethodPost, target, body, nil)
			request := handlerContractRequest(http.MethodPost, target, body, nil)
			response := httptest.NewRecorder()
			server.ServeHTTP(response, request)
			contract.requireValidResponse(t, request, response)
			if response.Code != test.status {
				t.Fatalf("status=%d want=%d body=%s", response.Code, test.status, response.Body.String())
			}
			if test.status != http.StatusOK {
				return
			}
			var output struct {
				SourceFormat string         `json:"sourceFormat"`
				MediaID      string         `json:"mediaId"`
				Document     map[string]any `json:"document"`
			}
			if err := json.Unmarshal(response.Body.Bytes(), &output); err != nil {
				t.Fatal(err)
			}
			if output.SourceFormat != test.sourceFormat || output.MediaID != test.mediaID || output.Document["revision"] != float64(0) || output.Document["name"] != test.documentName {
				t.Fatalf("response = %#v", output)
			}
		})
	}
}

type httpProjectImportCatalog struct{}

func (httpProjectImportCatalog) List(context.Context, string, int) (media.MediaPage, error) {
	return media.MediaPage{}, nil
}
func (httpProjectImportCatalog) Browse(context.Context, string, string, int) (media.FolderPage, error) {
	return media.FolderPage{}, nil
}
func (httpProjectImportCatalog) Get(_ context.Context, id string) (media.Media, error) {
	if id != httpImportMediaID {
		return media.Media{}, index.ErrNotFound
	}
	return media.Media{ID: id, DurationMS: 1_000}, nil
}
func (httpProjectImportCatalog) Refresh(context.Context) error { return nil }
func (httpProjectImportCatalog) Preview(context.Context, preview.PreviewSpec) (preview.TranscodeSpec, error) {
	return preview.TranscodeSpec{}, nil
}

func TestProjectImportHandlerBoundsAndRejectsMalformedRequests(t *testing.T) {
	contract := newHandlerContract(t)
	server := newHandlerContractServer(t, Config{ProjectImports: projects.ProjectUseCase{Media: httpProjectImportCatalog{}}})
	validEnvelope := func(content string) string {
		body, err := json.Marshal(map[string]string{"content": content})
		if err != nil {
			t.Fatal(err)
		}
		return string(body)
	}
	tests := []struct {
		name   string
		body   string
		status int
	}{
		{name: "malformed envelope", body: `{"content":`, status: http.StatusBadRequest},
		{name: "invalid UTF-8 envelope", body: string([]byte{0xff}), status: http.StatusBadRequest},
		{name: "unknown envelope field", body: `{"content":"{}","extra":true}`, status: http.StatusBadRequest},
		{name: "null content", body: `{"content":null}`, status: http.StatusBadRequest},
		{name: "trailing envelope", body: `{"content":"{}"} {}`, status: http.StatusBadRequest},
		{name: "trailing file JSON", body: validEnvelope(`{"mediaId":"` + httpImportMediaID + `","segments":[],"uiState":{}} {}`), status: http.StatusBadRequest},
		{name: "raw content cap plus one", body: validEnvelope(strings.Repeat(" ", projects.MaxProjectImportBytes+1)), status: http.StatusRequestEntityTooLarge},
		{name: "envelope cap plus one", body: `{"content":"` + strings.Repeat("x", maxProjectImportEnvelopeBytes) + `"}`, status: http.StatusRequestEntityTooLarge},
	}
	const target = "/api/v2/projects/import"
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := handlerContractRequest(http.MethodPost, target, test.body, nil)
			response := httptest.NewRecorder()
			server.ServeHTTP(response, request)
			contract.requireValidResponse(t, request, response)
			if response.Code != test.status {
				t.Fatalf("status=%d want=%d body=%s", response.Code, test.status, response.Body.String())
			}
		})
	}
}
