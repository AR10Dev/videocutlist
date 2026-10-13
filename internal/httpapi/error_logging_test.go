package httpapi

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"syscall"
	"testing"

	store "videocutlist/internal/db"
	"videocutlist/internal/projects"

	"modernc.org/sqlite"
)

type errorLoggingProjects struct {
	routeTestProjects
	errors []error
	calls  int
}

func (p *errorLoggingProjects) Get(context.Context, string) (Project, error) {
	err := p.errors[p.calls]
	p.calls++
	return Project{}, err
}

func TestReadinessFailureLogsCauseAndKeepsSafeEnvelope(t *testing.T) {
	const secret = "token=private\"\n\x00\u2028🙂 path=/private/database.db"
	var logs bytes.Buffer
	authenticator, err := NewAuthenticator(AuthConfig{Mode: "none"})
	if err != nil {
		t.Fatal(err)
	}
	server, err := New(Config{
		Authenticator: authenticator,
		Media:         &routeTestMedia{},
		Preview:       routeTestPreview{},
		Projects:      routeTestProjects{},
		BatchExports:  &routeTestBatchExports{},
		Jobs:          &routeTestJobs{},
		Logger:        log.New(&logs, "", 0),
		Ready: func(context.Context) error {
			return fmt.Errorf("readiness failed for %s: %w", secret, syscall.ENOSPC)
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	server.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/ready", nil))

	var envelope struct {
		Error struct {
			Code      string `json:"code"`
			Message   string `json:"message"`
			RequestID string `json:"requestId"`
		} `json:"error"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	if response.Code != http.StatusServiceUnavailable || envelope.Error.Code != "not_ready" || envelope.Error.Message != "Service is not ready." || envelope.Error.RequestID == "" || response.Header().Get("X-Request-ID") != envelope.Error.RequestID {
		t.Fatalf("readiness response changed or is uncorrelated: %d %s", response.Code, response.Body.String())
	}
	var record map[string]any
	if err := json.Unmarshal(bytes.TrimSpace(logs.Bytes()), &record); err != nil {
		t.Fatalf("request log is not valid JSON: %q: %v", logs.String(), err)
	}
	if record["request_id"] != envelope.Error.RequestID || record["route"] != "/ready" || record["error_cause"] != "os" || record["error_cause_code"] != float64(syscall.ENOSPC) {
		t.Fatalf("readiness log is not safely classified and correlated: %#v", record)
	}
	if strings.Contains(logs.String(), secret) || strings.Contains(response.Body.String(), secret) {
		t.Fatalf("readiness cause leaked into logs or response: log=%q response=%q", logs.String(), response.Body.String())
	}
}

func TestInternalErrorLogsSafeCorrelatedCause(t *testing.T) {
	const secret = "bearer-secret:/private/media\"\n\x00\u2028🙂"
	wrappedPermission := fmt.Errorf("request contained %s: %w", secret, &os.PathError{Op: "open", Path: "/private/media", Err: syscall.EACCES})
	database, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := database.Close(); err != nil {
			t.Error(err)
		}
	}()
	result, sqliteCause := database.Exec("SELECT * FROM missing_table")
	if sqliteCause == nil {
		t.Fatalf("invalid SQLite query unexpectedly succeeded: %#v", result)
	}
	sqliteError, ok := errors.AsType[*sqlite.Error](sqliteCause)
	if !ok {
		t.Fatalf("SQLite failure type = %T, want *sqlite.Error", sqliteCause)
	}
	wrappedSQLite := fmt.Errorf("database operation for %s: %w", secret, sqliteCause)
	unknown := fmt.Errorf("opaque failure %s: %w", secret, errors.New("opaque inner cause"))
	projectsWithErrors := &errorLoggingProjects{errors: []error{wrappedPermission, wrappedSQLite, unknown, store.ErrProjectNotFound}}
	var logs bytes.Buffer
	authenticator, err := NewAuthenticator(AuthConfig{Mode: "none"})
	if err != nil {
		t.Fatal(err)
	}
	server, err := New(Config{
		Authenticator: authenticator,
		Media:         &routeTestMedia{},
		Preview:       routeTestPreview{},
		Projects:      projectsWithErrors,
		BatchExports:  &routeTestBatchExports{},
		Jobs:          &routeTestJobs{},
		Logger:        log.New(&logs, "", 0),
	})
	if err != nil {
		t.Fatal(err)
	}

	projectID := "p_" + strings.Repeat("b", 12)
	responses := make([]*httptest.ResponseRecorder, 0, 4)
	for range 4 {
		response := httptest.NewRecorder()
		server.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/v2/projects/"+projectID, nil))
		responses = append(responses, response)
	}

	lines := strings.Split(strings.TrimSpace(logs.String()), "\n")
	if len(lines) != 4 {
		t.Fatalf("log lines = %d, want 4: %s", len(lines), logs.String())
	}
	var records []map[string]any
	for _, line := range lines {
		var record map[string]any
		if err := json.Unmarshal([]byte(line), &record); err != nil {
			t.Fatalf("request log is not valid JSON: %q: %v", line, err)
		}
		records = append(records, record)
	}

	for i := range 3 {
		response := responses[i]
		if response.Code != http.StatusInternalServerError {
			t.Fatalf("response %d status = %d, want 500: %s", i, response.Code, response.Body.String())
		}
		var envelope struct {
			Error struct {
				Code      string `json:"code"`
				Message   string `json:"message"`
				RequestID string `json:"requestId"`
			} `json:"error"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
			t.Fatalf("decode sanitized response: %v", err)
		}
		if envelope.Error.Code != "internal_error" || envelope.Error.Message != "Request could not be completed." || envelope.Error.RequestID == "" || response.Header().Get("X-Request-ID") != envelope.Error.RequestID {
			t.Fatalf("public 500 envelope changed or is uncorrelated: %s", response.Body.String())
		}
		if records[i]["request_id"] != envelope.Error.RequestID || records[i]["route"] != "/api/v2/projects/{projectId}" {
			t.Fatalf("request log is not correlated/bounded: %#v", records[i])
		}
	}
	if records[0]["error_cause"] != "filesystem" || records[0]["error_cause_code"] != float64(syscall.EACCES) {
		t.Fatalf("wrapped permission failure classification = %#v", records[0])
	}
	if records[1]["error_cause"] != "sqlite" || records[1]["error_cause_code"] != float64(sqliteError.Code()) {
		t.Fatalf("wrapped SQLite cause classification = %#v", records[1])
	}
	unknownType, ok := records[2]["error_type"].(string)
	if records[2]["error_cause"] != "unknown" || !ok || unknownType == "" {
		t.Fatalf("unknown cause classification = %#v", records[2])
	}
	if responses[3].Code != http.StatusNotFound {
		t.Fatalf("ordinary client error status = %d, want 404", responses[3].Code)
	}
	if _, ok := records[3]["error_cause"]; ok {
		t.Fatalf("ordinary client error has internal cause record: %#v", records[3])
	}
	if strings.Contains(logs.String(), secret) || strings.Contains(logs.String(), "/private/media") || strings.Contains(logs.String(), "opaque inner cause") {
		t.Fatalf("logs contain raw cause text or private path: %q", logs.String())
	}
	for _, response := range responses[:3] {
		if strings.Contains(response.Body.String(), secret) || strings.Contains(response.Body.String(), "/private/media") || strings.Contains(response.Body.String(), "opaque inner cause") {
			t.Fatalf("public response leaked internal cause: %q", response.Body.String())
		}
	}
}

var _ projects.ProjectService = (*errorLoggingProjects)(nil)
