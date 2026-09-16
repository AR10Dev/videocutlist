package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"

	store "videocutlist/internal/db"
	"videocutlist/internal/projects"
	"videocutlist/internal/projects/model"
	"videocutlist/internal/runtime"
)

type errorProjectRepository struct{ err error }

func (r errorProjectRepository) Get(context.Context, string) (projects.ProjectRecord, error) {
	return projects.ProjectRecord{}, r.err
}
func (r errorProjectRepository) Save(context.Context, string, int64, model.Document) (projects.ProjectRecord, error) {
	return projects.ProjectRecord{}, r.err
}

type errorMediaCatalog struct {
	runtime.MediaCatalog
	err error
}

func (m errorMediaCatalog) Get(_ context.Context, id string) (projects.Media, error) {
	return projects.Media{ID: id, DurationMS: 1000}, m.err
}

func TestProjectAndMediaErrorsPreserveClassification(t *testing.T) {
	privateFailure := errors.New("database unavailable: /private/database.db")
	projectPath := "/api/v1/projects/p_aaaaaaaaaaaa"
	mediaPath := "/api/v1/media/m_" + strings.Repeat("a", 43)
	valid := `{"revision":1,"schemaVersion":2,"name":"Project","items":[{"id":"i_aaaaaaaaaaaaaaaaaaaaaaaa","mediaId":"m_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","segments":[]}]}`
	for _, test := range []struct {
		name, method, path, body string
		repositoryErr, mediaErr  error
		status                   int
		code                     string
	}{
		{"project read failure", "GET", projectPath, "", privateFailure, nil, 500, "internal_error"},
		{"project write failure", "PUT", projectPath, valid, privateFailure, nil, 500, "internal_error"},
		{"project missing", "GET", projectPath, "", fmt.Errorf("get: %w", store.ErrProjectNotFound), nil, 404, "not_found"},
		{"update missing", "PUT", projectPath, valid, store.ErrProjectNotFound, nil, 404, "not_found"},
		{"revision conflict", "PUT", projectPath, valid, store.ErrRevisionConflict, nil, 409, "revision_conflict"},
		{"invalid document", "PUT", projectPath, strings.Replace(valid, `"schemaVersion":2`, `"schemaVersion":1`, 1), nil, nil, 422, "invalid_project"},
		{"missing project media", "PUT", projectPath, valid, nil, store.ErrMediaNotFound, 422, "invalid_project"},
		{"project media database failure", "PUT", projectPath, valid, nil, privateFailure, 500, "internal_error"},
		{"media read failure", "GET", mediaPath, "", nil, privateFailure, 500, "internal_error"},
		{"media missing", "GET", mediaPath, "", nil, store.ErrMediaNotFound, 404, "not_found"},
		{"preview media read failure", "GET", mediaPath + "/preview", "", nil, privateFailure, 500, "internal_error"},
		{"interchange project read failure", "GET", projectPath + "/interchange/csv", "", privateFailure, nil, 500, "internal_error"},
	} {
		t.Run(test.name, func(t *testing.T) {
			auth, err := NewAuthenticator(AuthConfig{Mode: "none"})
			if err != nil {
				t.Fatal(err)
			}
			catalog := errorMediaCatalog{err: test.mediaErr}
			server, err := New(Config{Authenticator: auth, Media: &projects.MediaUseCase{Catalog: catalog}, Preview: routeTestPreview{}, Projects: projects.ProjectUseCase{Repository: errorProjectRepository{test.repositoryErr}, Media: catalog}, BatchExports: &routeTestBatchExports{}, Jobs: &routeTestJobs{}})
			if err != nil {
				t.Fatal(err)
			}
			response := httptest.NewRecorder()
			server.ServeHTTP(response, httptest.NewRequest(test.method, test.path, strings.NewReader(test.body)))
			var envelope struct {
				Error struct{ Code, Message, RequestID string }
			}
			if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
				t.Fatal(err)
			}
			if response.Code != test.status || envelope.Error.Code != test.code || envelope.Error.Message == "" || envelope.Error.RequestID == "" || envelope.Error.RequestID != response.Header().Get("X-Request-ID") || strings.Contains(response.Body.String(), "/private") {
				t.Fatalf("response = %d %s", response.Code, response.Body.String())
			}
		})
	}
}
