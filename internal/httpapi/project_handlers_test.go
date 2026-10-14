package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"videocutlist/internal/projects"
	"videocutlist/internal/projects/model"
)

type projectHandlerService struct {
	project projects.Project
	saved   *projects.ProjectInput
}

func (s *projectHandlerService) Create(_ context.Context, _ string, input projects.ProjectInput) (projects.Project, error) {
	s.saved = &input
	return s.project, nil
}
func (s *projectHandlerService) Get(context.Context, string) (projects.Project, error) {
	return s.project, nil
}
func (s *projectHandlerService) Save(_ context.Context, _ string, input projects.ProjectInput) (projects.Project, error) {
	s.saved = &input
	return s.project, nil
}

func TestGetProjectResponseMapsFieldsAndOmitsOnlyZeroExportOptions(t *testing.T) {
	for _, test := range []struct {
		name        string
		options     model.ExportOptions
		wantOptions bool
	}{
		{name: "zero export options omitted"},
		{name: "nonzero export options retained", options: model.ExportOptions{Mode: "separate", Container: "mkv", StreamIndexes: []int{}}, wantOptions: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			service := &projectHandlerService{project: projectHandlerProject(test.options)}
			server := Server{config: Config{Projects: service}}
			response := httptest.NewRecorder()
			server.getProject(response, httptest.NewRequest(http.MethodGet, "/", nil), "p_001", "request")
			if response.Code != http.StatusOK {
				t.Fatalf("status = %d, body = %s", response.Code, response.Body)
			}
			var body struct {
				ID            string    `json:"id"`
				UpdatedAt     time.Time `json:"updatedAt"`
				Revision      int       `json:"revision"`
				SchemaVersion int       `json:"schemaVersion"`
				Name          string    `json:"name"`
				Items         []struct {
					ID       string `json:"id"`
					MediaID  string `json:"mediaId"`
					Segments []struct {
						ID       *string `json:"id"`
						StartMS  int     `json:"startMs"`
						EndMS    int     `json:"endMs"`
						Label    *string `json:"label"`
						Included *bool   `json:"included"`
					} `json:"segments"`
					EditorState *struct {
						PlayheadMS int     `json:"playheadMs"`
						Zoom       float64 `json:"zoom"`
						Muted      bool    `json:"muted"`
					} `json:"editorState"`
					ExportOptions json.RawMessage `json:"exportOptions"`
				} `json:"items"`
			}
			if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			if body.ID != "p_001" || body.Revision != 7 || body.SchemaVersion != 2 || body.Name != "Project" || !body.UpdatedAt.Equal(time.Date(2025, 1, 2, 3, 4, 5, 0, time.UTC)) {
				t.Fatalf("project envelope fields = %#v", body)
			}
			if len(body.Items) != 1 {
				t.Fatalf("project items = %#v", body.Items)
			}
			item := body.Items[0]
			if item.ID != "i_aaaaaaaaaaaaaaaaaaaaaaaa" || item.MediaID != "m_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" || len(item.Segments) != 1 {
				t.Fatalf("project item fields = %#v", item)
			}
			segment := item.Segments[0]
			if segment.ID == nil || *segment.ID != "s_custom" || segment.StartMS != 5 || segment.EndMS != 15 || segment.Label == nil || *segment.Label != "label" || segment.Included == nil || *segment.Included {
				t.Fatalf("segment fields = %#v", segment)
			}
			if item.EditorState == nil || item.EditorState.PlayheadMS != 11 || item.EditorState.Zoom != 1.5 || !item.EditorState.Muted {
				t.Fatalf("editor state = %#v", item.EditorState)
			}
			if count := strings.Count(response.Body.String(), `"exportOptions"`); (count == 1) != test.wantOptions {
				t.Fatalf("exportOptions key count = %d, want present=%t: %s", count, test.wantOptions, response.Body)
			}
			if !test.wantOptions {
				if item.ExportOptions != nil {
					t.Fatalf("zero export options unexpectedly present: %s", item.ExportOptions)
				}
				return
			}
			var options struct {
				Mode          string `json:"mode"`
				Container     string `json:"container"`
				StreamIndexes *[]int `json:"streamIndexes"`
			}
			if err := json.Unmarshal(item.ExportOptions, &options); err != nil {
				t.Fatal(err)
			}
			if options.Mode != "separate" || options.Container != "mkv" || options.StreamIndexes == nil || *options.StreamIndexes == nil || len(*options.StreamIndexes) != 0 {
				t.Fatalf("nonzero export options = %#v", options)
			}
		})
	}
}

func TestPutProjectMapsTypedFieldsAndExplicitSegmentInclusion(t *testing.T) {
	service := &projectHandlerService{project: projectHandlerProject(model.ExportOptions{})}
	server := Server{config: Config{Projects: service}}
	body := `{"revision":6,"schemaVersion":2,"name":"Incoming","items":[{"id":"i_aaaaaaaaaaaaaaaaaaaaaaaa","mediaId":"m_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","segments":[{"startMs":0,"endMs":10,"included":false},{"startMs":10,"endMs":20},{"startMs":20,"endMs":30,"included":true},{"startMs":30,"endMs":40,"included":null}],"exportOptions":{"streamIndexes":[]}}]}`
	response := httptest.NewRecorder()
	server.putProject(response, httptest.NewRequest(http.MethodPut, "/", strings.NewReader(body)), "p_001", "request")
	if response.Code != http.StatusOK || service.saved == nil {
		t.Fatalf("status=%d saved=%#v body=%s", response.Code, service.saved, response.Body)
	}
	input := *service.saved
	segments := input.Document.Items[0].Segments
	if input.Revision != 6 || input.Name != "Incoming" || len(segments) != 4 || segments[0].IsIncluded() || !segments[1].IsIncluded() || !segments[2].IsIncluded() || !segments[3].IsIncluded() {
		t.Fatalf("saved project input lost typed fields/default inclusion: %#v", input)
	}
	// The repository stores the document as JSON; defaults must survive that round trip.
	stored, err := json.Marshal(input.Document)
	if err != nil {
		t.Fatal(err)
	}
	var reloaded model.Document
	if err := json.Unmarshal(stored, &reloaded); err != nil {
		t.Fatal(err)
	}
	for i, segment := range reloaded.Items[0].Segments {
		if segment.IsIncluded() != (i != 0) {
			t.Fatalf("segment %d inclusion changed after persistence: %s", i, stored)
		}
	}
	if input.Items[0].ExportOptions.StreamIndexes == nil || len(input.Items[0].ExportOptions.StreamIndexes) != 0 {
		t.Fatalf("explicit empty stream indexes lost: %#v", input.Document.Items[0].ExportOptions)
	}
}

func TestProjectPageResponsePreservesListAndCursorMetadata(t *testing.T) {
	for _, test := range []struct {
		name       string
		items      []projects.ProjectSummary
		cursor     *string
		wantItems  string
		wantCursor string
	}{
		{name: "nil items and cursor", wantItems: `"items":null`, wantCursor: `"nextCursor":null`},
		{name: "empty items and cursor value", items: []projects.ProjectSummary{}, cursor: stringPointer("next"), wantItems: `"items":[]`, wantCursor: `"nextCursor":"next"`},
		{name: "typed summary metadata", items: []projects.ProjectSummary{{ID: "p_001", Name: "Summary", Revision: 4}}, wantItems: `"items":[{"id":"p_001","name":"Summary","revision":4`, wantCursor: `"nextCursor":null`},
	} {
		t.Run(test.name, func(t *testing.T) {
			response := httptest.NewRecorder()
			writeProjectPageJSON(response, "request", projects.ProjectPage{Items: test.items, NextCursor: test.cursor})
			if !strings.Contains(response.Body.String(), test.wantItems) || !strings.Contains(response.Body.String(), test.wantCursor) {
				t.Fatalf("project page response = %s", response.Body)
			}
		})
	}
}

func projectHandlerProject(options model.ExportOptions) projects.Project {
	return projects.Project{
		Document: model.Document{SchemaVersion: 2, Name: "Project", Items: []model.ProjectItem{{
			ID: "i_aaaaaaaaaaaaaaaaaaaaaaaa", MediaID: "m_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			Segments:    []model.Segment{(model.Segment{ID: "s_custom", StartMS: 5, EndMS: 15, Label: "label"}).WithIncluded(false)},
			EditorState: &model.UIState{PlayheadMS: 11, Zoom: 1.5, Muted: true}, ExportOptions: options,
		}}},
		ID: "p_001", Revision: 7, UpdatedAt: time.Date(2025, 1, 2, 3, 4, 5, 0, time.UTC),
	}
}

func stringPointer(value string) *string { return &value }
