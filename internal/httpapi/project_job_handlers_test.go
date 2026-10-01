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
	err                  error
	submits              int
	retries              int
	request              projects.BatchExportRequest
	retryJobID, retryKey string
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
func (*contractBatchService) List(context.Context, string, int) (projects.BatchPage, error) {
	return projects.BatchPage{}, nil
}
func (s *contractBatchService) Retry(_ context.Context, jobID, key string) (projects.Batch, error) {
	s.retries++
	s.retryJobID, s.retryKey = jobID, key
	return projects.Batch{BatchID: "b_contract1234"}, s.err
}
func (*contractBatchService) Cancel(context.Context, string) error { return nil }

type contractDetectionService struct {
	err     error
	creates int
}

func (s *contractDetectionService) Submit(context.Context, string, string, DetectionRequest) (DetectionJob, error) {
	s.creates++
	return DetectionJob{ID: "j_detection1234", State: "queued"}, s.err
}

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

func TestCreateDetectionRequiresKeyAndValidInputBeforeSubmission(t *testing.T) {
	valid := `{"mediaId":"m_contract","projectItemId":"i_contract123456789012345678","projectRevision":7,"kind":"silence"}`
	for _, test := range []struct {
		name   string
		key    string
		body   string
		status int
		code   string
	}{
		{name: "missing key", body: valid, status: http.StatusBadRequest, code: "invalid_idempotency_key"},
		{name: "invalid key", key: "bad key", body: valid, status: http.StatusBadRequest, code: "invalid_idempotency_key"},
		{name: "malformed JSON", key: "valid-key", body: "{", status: http.StatusBadRequest, code: "invalid_detection"},
		{name: "invalid kind", key: "valid-key", body: strings.Replace(valid, `"silence"`, `"unknown"`, 1), status: http.StatusBadRequest, code: "invalid_detection"},
	} {
		t.Run(test.name, func(t *testing.T) {
			detection := &contractDetectionService{}
			server := &Server{config: Config{Detection: detection}, metrics: NewMetrics()}
			request := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(test.body))
			request.Header.Set("Idempotency-Key", test.key)
			response := httptest.NewRecorder()
			server.createDetection(response, request, "p_contract1234", "request")
			if response.Code != test.status || contractErrorCode(t, response) != test.code {
				t.Fatalf("response = %d %s", response.Code, response.Body.String())
			}
			if detection.creates != 0 {
				t.Fatalf("detection submitted = %d", detection.creates)
			}
		})
	}
}

func TestCreateExportRequiresValidIdempotencyKey(t *testing.T) {
	for _, key := range []string{"", "bad key", strings.Repeat("a", 129)} {
		t.Run(fmt.Sprintf("key_%d", len(key)), func(t *testing.T) {
			batch := &contractBatchService{}
			server := &Server{config: Config{BatchExports: batch}, metrics: NewMetrics()}
			request := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"projectRevision":7,"itemIds":["i_contract"]}`))
			request.Header.Set("Idempotency-Key", key)
			response := httptest.NewRecorder()
			server.createExport(response, request, "p_contract1234", "request")
			if response.Code != http.StatusBadRequest || contractErrorCode(t, response) != "invalid_idempotency_key" {
				t.Fatalf("response = %d %s", response.Code, response.Body.String())
			}
			if batch.submits != 0 {
				t.Fatalf("invalid key submitted: %d", batch.submits)
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
		{name: "obsolete options are rejected", body: `{"mode":"merge"}`, status: http.StatusBadRequest, code: "invalid_export"},
		{name: "missing project", err: fmt.Errorf("load project: %w", store.ErrProjectNotFound), body: `{"projectRevision":7,"itemIds":["i_contract"]}`, status: http.StatusNotFound, code: "not_found"},
		{name: "queue capacity", err: jobqueue.ErrQueueFull, body: `{"projectRevision":7,"itemIds":["i_contract"]}`, status: http.StatusTooManyRequests, code: "export_busy"},
		{name: "idempotency conflict", err: jobqueue.ErrAdmissionConflict, body: `{"projectRevision":7,"itemIds":["i_contract"]}`, status: http.StatusConflict, code: "idempotency_conflict"},
		{name: "stale project", err: store.ErrRevisionConflict, body: `{"projectRevision":7,"itemIds":["i_contract"]}`, status: http.StatusConflict, code: "stale_project"},
		{name: "invalid project", err: projects.ErrInvalidProject, body: `{"projectRevision":7,"itemIds":["i_contract"]}`, status: http.StatusBadRequest, code: "invalid_export"},
		{name: "unexpected failure", err: errors.New("database unavailable"), body: `{"projectRevision":7,"itemIds":["i_contract"]}`, status: http.StatusInternalServerError, code: "internal_error"},
	} {
		t.Run(test.name, func(t *testing.T) {
			batch := &contractBatchService{err: test.err}
			server := &Server{config: Config{BatchExports: batch}, metrics: NewMetrics()}
			request := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(test.body))
			request.Header.Set("Idempotency-Key", "handler-key")
			response := httptest.NewRecorder()
			server.createExport(response, request, "p_contract1234", "request")
			if response.Code != test.status || contractErrorCode(t, response) != test.code {
				t.Fatalf("response = %d %s", response.Code, response.Body.String())
			}
			if test.name == "obsolete options are rejected" && batch.submits != 0 {
				t.Fatalf("obsolete request submitted: %d", batch.submits)
			}
			if test.name != "obsolete options are rejected" && (batch.request.ProjectID != "p_contract1234" || batch.request.ProjectRevision != 7 || batch.request.IdempotencyKey != "handler-key") {
				t.Fatalf("service request = %+v", batch.request)
			}
		})
	}
}

func TestRetryJobRequiresAndPassesIdempotencyKey(t *testing.T) {
	batch := &contractBatchService{}
	server := &Server{config: Config{BatchExports: batch}, metrics: NewMetrics()}
	for _, key := range []string{"", "invalid key", strings.Repeat("a", 129)} {
		request := httptest.NewRequest(http.MethodPost, "/", nil)
		request.Header.Set("Idempotency-Key", key)
		response := httptest.NewRecorder()
		server.retryJob(response, request, "j_contract1234", "request")
		if response.Code != http.StatusBadRequest || contractErrorCode(t, response) != "invalid_idempotency_key" {
			t.Fatalf("key length %d: response = %d %s", len(key), response.Code, response.Body.String())
		}
	}
	request := httptest.NewRequest(http.MethodPost, "/", nil)
	request.Header.Set("Idempotency-Key", "retry-handler-key")
	response := httptest.NewRecorder()
	server.retryJob(response, request, "j_contract1234", "request")
	if response.Code != http.StatusAccepted || batch.retries != 1 || batch.retryJobID != "j_contract1234" || batch.retryKey != "retry-handler-key" {
		t.Fatalf("retry response=%d calls=%d request=%+v body=%s", response.Code, batch.retries, batch.retryJobID, response.Body.String())
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
