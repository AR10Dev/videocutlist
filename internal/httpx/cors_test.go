package httpx

import (
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
