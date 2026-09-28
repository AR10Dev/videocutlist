package httpapi

import (
	"bytes"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

var errMetricsWriter = errors.New("metrics writer failed")

type metricsErrorWriter struct{}

func (metricsErrorWriter) Write([]byte) (int, error) { return 0, errMetricsWriter }

func TestMetricsWritePrometheusReturnsWriterError(t *testing.T) {
	err := NewMetrics().WritePrometheus(metricsErrorWriter{})
	if !errors.Is(err, errMetricsWriter) {
		t.Fatalf("WritePrometheus error = %v, want writer error", err)
	}
}

func TestMetricsBoundsMethodsAndAggregatesLatency(t *testing.T) {
	metrics := NewMetrics()
	for i := range 100 {
		metrics.HTTP("/api/v1/unknown", fmt.Sprintf("CUSTOM%d", i), "4xx", 0.25)
	}
	metrics.HTTP("/api/v1/media", "GET", "2xx", 1)
	metrics.HTTP("/api/v1/media", "GET", "2xx", 2)
	var output bytes.Buffer
	if err := metrics.WritePrometheus(&output); err != nil {
		t.Fatal(err)
	}
	text := output.String()
	for _, want := range []string{
		`http_requests_total{route="/api/v1/unknown",method="OTHER",status_class="4xx"} 100`,
		`http_request_duration_seconds_sum{route="/api/v1/media",method="GET",status_class="2xx"} 3`,
		`http_request_duration_seconds_count{route="/api/v1/media",method="GET",status_class="2xx"} 2`,
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("missing %q in metrics:\n%s", want, text)
		}
	}
	if strings.Contains(text, "CUSTOM") {
		t.Fatalf("unbounded method labels in metrics:\n%s", text)
	}
}

func TestMetricsRequiresDeploymentAuthentication(t *testing.T) {
	auth, err := NewAuthenticator(AuthConfig{Mode: "bearer", BearerToken: "private-metrics-token"})
	if err != nil {
		t.Fatal(err)
	}
	server, err := New(Config{Authenticator: auth, Media: &routeTestMedia{}, Preview: routeTestPreview{}, Projects: routeTestProjects{}, BatchExports: &routeTestBatchExports{}, Jobs: &routeTestJobs{}})
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		token  string
		status int
	}{
		{"", http.StatusUnauthorized},
		{"wrong", http.StatusUnauthorized},
		{"private-metrics-token", http.StatusOK},
	} {
		request := httptest.NewRequest(http.MethodGet, "/metrics", nil)
		if test.token != "" {
			request.Header.Set("Authorization", "Bearer "+test.token)
		}
		response := httptest.NewRecorder()
		server.ServeHTTP(response, request)
		if response.Code != test.status {
			t.Errorf("token %q: status = %d, want %d", test.token, response.Code, test.status)
		}
		if test.status == http.StatusUnauthorized && strings.Contains(response.Body.String(), "http_requests_total") {
			t.Error("metrics leaked to unauthenticated client")
		}
		if test.status == http.StatusOK && !strings.Contains(response.Body.String(), "http_requests_total") {
			t.Error("authenticated metrics response missing counters")
		}
	}
}
