package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCORSPassesRequestsWithoutOrigin(t *testing.T) {
	called := false
	handler := CORS([]string{"https://editor.example.test"}, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		called = true
		w.WriteHeader(http.StatusCreated)
	}))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "http://api.test", nil))
	if response.Code != http.StatusCreated || !called || response.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Fatalf("status = %d, called = %v, origin = %q", response.Code, called, response.Header().Get("Access-Control-Allow-Origin"))
	}
}

func TestCORSAllowsSameOriginWithoutConfiguration(t *testing.T) {
	called := false
	handler := CORS(nil, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		called = true
		w.WriteHeader(http.StatusOK)
	}))
	request := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:8787/assets/app.js", nil)
	request.Header.Set("Origin", "http://127.0.0.1:8787")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || !called {
		t.Fatalf("same-origin status=%d called=%v", response.Code, called)
	}
}

func TestCORSEnforcesExactOrigins(t *testing.T) {
	for name, origin := range map[string]string{
		"empty allowlist":        "https://editor.example.test",
		"wildcard configuration": "https://editor.example.test",
		"suffix mismatch":        "https://sub.editor.example.test",
		"malformed origin":       "https://editor.example.test/path",
	} {
		t.Run(name, func(t *testing.T) {
			allowed := []string{"https://editor.example.test"}
			if name == "empty allowlist" {
				allowed = nil
			}
			if name == "wildcard configuration" {
				allowed = []string{"*"}
			}
			called := false
			handler := CORS(allowed, http.HandlerFunc(func(http.ResponseWriter, *http.Request) { called = true }))
			request := httptest.NewRequest(http.MethodGet, "http://api.test", nil)
			request.Header.Set("Origin", origin)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != http.StatusForbidden || called {
				t.Fatalf("status = %d, called = %v", response.Code, called)
			}
		})
	}
}

func TestCORSAllowsActualAndValidPreflight(t *testing.T) {
	called := 0
	handler := CORS([]string{"https://editor.example.test"}, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		called++
		w.WriteHeader(http.StatusOK)
	}))
	actual := httptest.NewRequest(http.MethodGet, "http://api.test", nil)
	actual.Header.Set("Origin", "https://editor.example.test")
	actualResponse := httptest.NewRecorder()
	handler.ServeHTTP(actualResponse, actual)
	if actualResponse.Code != http.StatusOK || actualResponse.Header().Get("Access-Control-Allow-Origin") != "https://editor.example.test" || actualResponse.Header().Get("Access-Control-Allow-Credentials") != "true" || actualResponse.Header().Get("Access-Control-Expose-Headers") == "" || !variesOn(actualResponse.Header(), "Origin") {
		t.Fatalf("actual response = %#v", actualResponse.Result())
	}

	preflight := httptest.NewRequest(http.MethodOptions, "http://api.test", nil)
	preflight.Header.Set("Origin", "https://editor.example.test")
	preflight.Header.Set("Access-Control-Request-Method", http.MethodPut)
	preflight.Header.Set("Access-Control-Request-Headers", "authorization, If-Match")
	preflightResponse := httptest.NewRecorder()
	handler.ServeHTTP(preflightResponse, preflight)
	if preflightResponse.Code != http.StatusNoContent || called != 1 || preflightResponse.Header().Get("Access-Control-Allow-Methods") != "GET, HEAD, POST, PUT, DELETE" || preflightResponse.Header().Get("Access-Control-Allow-Headers") != "Authorization, Content-Type, If-Match, If-None-Match" || preflightResponse.Header().Get("Access-Control-Expose-Headers") != "" || !variesOn(preflightResponse.Header(), "Origin") || !variesOn(preflightResponse.Header(), "Access-Control-Request-Method") || !variesOn(preflightResponse.Header(), "Access-Control-Request-Headers") {
		t.Fatalf("preflight status = %d, calls = %d, headers = %#v", preflightResponse.Code, called, preflightResponse.Header())
	}
}

func variesOn(headers http.Header, value string) bool {
	for _, header := range headers.Values("Vary") {
		for _, item := range strings.Split(header, ",") {
			if strings.EqualFold(strings.TrimSpace(item), value) {
				return true
			}
		}
	}
	return false
}

func TestCORSRejectsMalformedPreflightBeforeDownstream(t *testing.T) {
	for name, test := range map[string]struct{ method, headers string }{
		"unsupported method": {http.MethodPatch, "Authorization"},
		"unsupported header": {http.MethodGet, "X-Forwarded-User"},
		"missing method":     {"", "Authorization"},
	} {
		t.Run(name, func(t *testing.T) {
			called := false
			handler := CORS([]string{"https://editor.example.test"}, http.HandlerFunc(func(http.ResponseWriter, *http.Request) { called = true }))
			request := httptest.NewRequest(http.MethodOptions, "http://api.test", nil)
			request.Header.Set("Origin", "https://editor.example.test")
			if test.method != "" {
				request.Header.Set("Access-Control-Request-Method", test.method)
			}
			request.Header.Set("Access-Control-Request-Headers", test.headers)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != http.StatusForbidden || called {
				t.Fatalf("status = %d, called = %v", response.Code, called)
			}
		})
	}
}

func TestAPICORSErrorsAndLogsAreCorrelated(t *testing.T) {
	for _, test := range []struct {
		name, method string
		origins      []string
		status       int
	}{
		{"no origin", http.MethodGet, nil, http.StatusOK},
		{"allowed", http.MethodGet, []string{"https://editor.test"}, http.StatusOK},
		{"disallowed", http.MethodGet, []string{"https://private-secret.test"}, http.StatusForbidden},
		{"malformed", http.MethodGet, []string{"https://editor.test/private-secret"}, http.StatusForbidden},
		{"multiple", http.MethodGet, []string{"https://editor.test", "https://private-secret.test"}, http.StatusForbidden},
		{"invalid preflight", http.MethodOptions, []string{"https://editor.test"}, http.StatusForbidden},
	} {
		t.Run(test.name, func(t *testing.T) {
			var logs bytes.Buffer
			var contextID string
			auth, err := NewAuthenticator(AuthConfig{Mode: "none"})
			if err != nil {
				t.Fatal(err)
			}
			server, err := New(Config{Authenticator: auth, Media: &routeTestMedia{}, Preview: routeTestPreview{}, Projects: routeTestProjects{}, BatchExports: &routeTestBatchExports{}, Jobs: &routeTestJobs{}, AllowedOrigins: []string{"https://editor.test"}, Logger: log.New(&logs, "", 0), Ready: func(ctx context.Context) error {
				contextID = RequestIDFromContext(ctx)
				return nil
			}})
			if err != nil {
				t.Fatal(err)
			}
			request := httptest.NewRequest(test.method, "/api/v1/ready?secret=private-secret", strings.NewReader("private-secret"))
			request.Header["Origin"] = test.origins
			request.Header.Set("Authorization", "Bearer private-secret")
			request.Header.Set("Cookie", "session=private-secret")
			request.Header.Set("X-Request-ID", "private-secret")
			response := httptest.NewRecorder()
			server.ServeHTTP(response, request)
			id := response.Header().Get("X-Request-ID")
			if response.Code != test.status || id == "" || id == "private-secret" {
				t.Fatalf("response = %d %s", response.Code, response.Body.String())
			}
			var entry map[string]any
			if err := json.Unmarshal(logs.Bytes(), &entry); err != nil {
				t.Fatal(err)
			}
			for _, field := range []string{"request_id", "method", "route", "duration_ms", "status", "error_category"} {
				if _, ok := entry[field]; !ok {
					t.Errorf("missing log field %s: %s", field, logs.String())
				}
			}
			if strings.Contains(logs.String(), "private-secret") || entry["request_id"] != id || entry["method"] != test.method {
				t.Fatalf("unsafe or uncorrelated log: %s", logs.String())
			}
			if test.status == http.StatusForbidden {
				var envelope struct {
					Error struct{ Code, Message, RequestID string }
				}
				if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
					t.Fatal(err)
				}
				if envelope.Error.Code != "origin_forbidden" || envelope.Error.RequestID != id || envelope.Error.Message == "" || entry["error_category"] != "origin_forbidden" {
					t.Fatalf("error = %s; log = %s", response.Body.String(), logs.String())
				}
			} else if contextID != id {
				t.Fatalf("context correlation = %q, header = %q", contextID, id)
			}
		})
	}
}

func TestCORSDoesNotReplaceMCPProtocolWithREST(t *testing.T) {
	handler := CORS(nil, http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Fatal("unexpected dispatch") }))
	request := httptest.NewRequest(http.MethodPost, "/mcp", nil)
	request.Header.Set("Origin", "https://disallowed.test")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden || response.Body.Len() != 0 {
		t.Fatalf("MCP received REST error: %d %s", response.Code, response.Body.String())
	}
}
