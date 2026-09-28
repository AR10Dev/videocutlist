package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	store "videocutlist/internal/db"
	jobqueue "videocutlist/internal/jobs"
	"videocutlist/internal/projects"
	"videocutlist/internal/projects/model"
)

type contractProjectService struct {
	project projects.Project
	err     error
}

func (s contractProjectService) Create(context.Context, string, projects.ProjectInput) (projects.Project, error) {
	return projects.Project{}, nil
}
func (s contractProjectService) Get(context.Context, string) (projects.Project, error) {
	return s.project, s.err
}
func (s contractProjectService) Save(context.Context, string, projects.ProjectInput) (projects.Project, error) {
	return projects.Project{}, nil
}

type contractBatchService struct {
	err     error
	submits int
	request projects.BatchExportRequest
}

func (s *contractBatchService) Submit(_ context.Context, request projects.BatchExportRequest) (string, []projects.Job, error) {
	s.submits++
	s.request = request
	return "b_contract1234", []projects.Job{{ID: "j_contract1234", State: string(jobqueue.JobQueued)}}, s.err
}
func (*contractBatchService) Progress(context.Context, string) (jobqueue.JobState, float64, error) {
	return jobqueue.JobQueued, 0, nil
}
func (*contractBatchService) Get(context.Context, string) (projects.Batch, error) {
	return projects.Batch{}, nil
}
func (*contractBatchService) List(context.Context, int) (projects.BatchPage, error) {
	return projects.BatchPage{}, nil
}
func (*contractBatchService) Retry(context.Context, string) (projects.Batch, error) {
	return projects.Batch{}, nil
}
func (*contractBatchService) Cancel(context.Context, string) error { return nil }

type contractDetectionService struct {
	err     error
	creates int
}

func (s *contractDetectionService) Create(context.Context, string, DetectionRequest) (DetectionJob, error) {
	s.creates++
	return DetectionJob{ID: "j_detection1234", State: "queued"}, s.err
}
func (*contractDetectionService) Get(context.Context, string) (DetectionJob, error) {
	return DetectionJob{}, nil
}
func (*contractDetectionService) Cancel(context.Context, string) error { return nil }

type contractJobService struct {
	getErr    error
	cancelErr error
}

func (s *contractJobService) Get(context.Context, string) (Job, error) {
	return Job{}, s.getErr
}
func (s *contractJobService) Cancel(context.Context, string) error { return s.cancelErr }

func contractErrorCode(t *testing.T, response *httptest.ResponseRecorder) string {
	t.Helper()
	var envelope struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("decode error response: %v; body=%s", err, response.Body.String())
	}
	return envelope.Error.Code
}

func TestCreateDetectionSeparatesInvalidInputFromStaleProject(t *testing.T) {
	project := projects.Project{
		Revision: 7,
		Document: model.Document{Items: []model.ProjectItem{{ID: "i_contract123456789012345678", MediaID: "m_contract"}}},
	}
	valid := `{"mediaId":"m_contract","projectItemId":"i_contract123456789012345678","projectRevision":7,"kind":"silence"}`
	for _, test := range []struct {
		name   string
		body   string
		status int
		code   string
	}{
		{name: "malformed JSON", body: "{", status: http.StatusUnprocessableEntity, code: "invalid_detection"},
		{name: "invalid kind", body: strings.Replace(valid, `"silence"`, `"unknown"`, 1), status: http.StatusUnprocessableEntity, code: "invalid_detection"},
		{name: "stale revision", body: strings.Replace(valid, `"projectRevision":7`, `"projectRevision":6`, 1), status: http.StatusConflict, code: "stale_project"},
		{name: "stale item membership", body: strings.Replace(valid, `"projectItemId":"i_contract123456789012345678"`, `"projectItemId":"i_other1234567890123456789"`, 1), status: http.StatusConflict, code: "stale_project"},
	} {
		t.Run(test.name, func(t *testing.T) {
			detection := &contractDetectionService{}
			server := &Server{
				config:  Config{Projects: contractProjectService{project: project}, Detection: detection},
				metrics: NewMetrics(),
			}
			response := httptest.NewRecorder()
			server.createDetection(response, httptest.NewRequest(http.MethodPost, "/", strings.NewReader(test.body)), "p_contract1234", "request")
			if response.Code != test.status || contractErrorCode(t, response) != test.code {
				t.Fatalf("response = %d %s", response.Code, response.Body.String())
			}
			if detection.creates != 0 {
				t.Fatalf("detection creates = %d", detection.creates)
			}
		})
	}
}

func TestCreateExportUsesRequestAndServiceErrorTaxonomy(t *testing.T) {
	for _, test := range []struct {
		name   string
		err    error
		body   string
		status int
		code   string
	}{
		{name: "obsolete options are rejected", body: `{"mode":"merge"}`, status: http.StatusUnprocessableEntity, code: "invalid_export"},
		{name: "missing project", err: fmt.Errorf("load project: %w", store.ErrProjectNotFound), body: `{"itemIds":["i_contract"]}`, status: http.StatusNotFound, code: "not_found"},
		{name: "queue capacity", err: jobqueue.ErrQueueFull, body: `{"itemIds":["i_contract"]}`, status: http.StatusTooManyRequests, code: "export_busy"},
		{name: "invalid project", err: projects.ErrInvalidProject, body: `{"itemIds":["i_contract"]}`, status: http.StatusUnprocessableEntity, code: "invalid_export"},
		{name: "unexpected failure", err: errors.New("database unavailable"), body: `{"itemIds":["i_contract"]}`, status: http.StatusInternalServerError, code: "internal_error"},
	} {
		t.Run(test.name, func(t *testing.T) {
			batch := &contractBatchService{err: test.err}
			server := &Server{config: Config{BatchExports: batch}, metrics: NewMetrics()}
			response := httptest.NewRecorder()
			server.createExport(response, httptest.NewRequest(http.MethodPost, "/", strings.NewReader(test.body)), "p_contract1234", "request")
			if response.Code != test.status || contractErrorCode(t, response) != test.code {
				t.Fatalf("response = %d %s", response.Code, response.Body.String())
			}
			if test.name == "obsolete options are rejected" && batch.submits != 0 {
				t.Fatalf("obsolete request submitted: %d", batch.submits)
			}
		})
	}
}

func TestJobHandlersExposeOnlyNotFoundAs404(t *testing.T) {
	for _, test := range []struct {
		name string
		err  error
	}{
		{name: "not found", err: jobqueue.ErrJobNotFound},
		{name: "unexpected", err: errors.New("database unavailable")},
	} {
		t.Run(test.name, func(t *testing.T) {
			for _, operation := range []string{"get", "cancel"} {
				jobs := &contractJobService{getErr: test.err, cancelErr: test.err}
				server := &Server{config: Config{Jobs: jobs}, metrics: NewMetrics()}
				response := httptest.NewRecorder()
				request := httptest.NewRequest(http.MethodGet, "/", nil)
				if operation == "get" {
					server.getJob(response, request, "j_contract1234", "request")
				} else {
					server.cancelJob(response, request, "j_contract1234", "request")
				}
				wantStatus, wantCode := http.StatusNotFound, "not_found"
				if test.name == "unexpected" {
					wantStatus, wantCode = http.StatusInternalServerError, "internal_error"
				}
				if response.Code != wantStatus || contractErrorCode(t, response) != wantCode {
					t.Fatalf("%s response = %d %s", operation, response.Code, response.Body.String())
				}
			}
		})
	}
}
