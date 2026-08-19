package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"videocutlist/application"
	"videocutlist/domain"
)

func TestParseRoute(t *testing.T) {
	media := "m_" + strings.Repeat("a", 43)
	project := "p_" + strings.Repeat("b", 12)
	job := "j_" + strings.Repeat("c", 12)
	tests := []struct {
		name, method, path string
		kind               routeKind
		id                 string
	}{
		{"list", http.MethodGet, "/api/v1/media", routeListMedia, ""},
		{"refresh", http.MethodPost, "/api/v1/media/refresh", routeRefreshMedia, ""},
		{"media", http.MethodGet, "/api/v1/media/" + media, routeGetMedia, media},
		{"preview head", http.MethodHead, "/api/v1/media/" + media + "/preview", routePreview, media},
		{"project put", http.MethodPut, "/api/v1/projects/" + project, routePutProject, project},
		{"export", http.MethodPost, "/api/v1/projects/" + project + "/exports", routeCreateExport, project},
		{"job delete", http.MethodDelete, "/api/v1/jobs/" + job, routeCancelJob, job},
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

type routeTestMedia struct{ gets int }

func (m *routeTestMedia) List(context.Context, string, int) (MediaPage, error) {
	return MediaPage{}, nil
}
func (m *routeTestMedia) Get(context.Context, string) (Media, error) {
	m.gets++
	return Media{}, nil
}
func (m *routeTestMedia) RefreshMedia(context.Context) error { return nil }

type routeTestPreview struct{}

func (routeTestPreview) Start(context.Context, domain.Principal, PreviewSpec) (PreviewResult, error) {
	return PreviewResult{}, nil
}
func (routeTestPreview) Cached(context.Context, PreviewSpec) (bool, error) { return false, nil }

type routeTestProjects struct{}

func (routeTestProjects) Get(context.Context, domain.Principal, string) (Project, error) {
	return Project{}, nil
}
func (routeTestProjects) Save(context.Context, domain.Principal, string, application.ProjectInput, int64) (Project, error) {
	return Project{}, nil
}

type routeTestExports struct{}

func (routeTestExports) Create(context.Context, domain.Principal, string, Project, ExportInput) (Job, error) {
	return Job{}, nil
}

type routeTestJobs struct{}

func (routeTestJobs) Get(context.Context, domain.Principal, string) (Job, error) { return Job{}, nil }
func (routeTestJobs) Cancel(context.Context, domain.Principal, string) error     { return nil }

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
		Jobs:          routeTestJobs{},
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
