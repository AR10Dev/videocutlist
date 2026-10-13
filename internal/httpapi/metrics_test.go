package httpapi

import (
	"bytes"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	io_prometheus_client "github.com/prometheus/client_model/go"
	store "videocutlist/internal/db"
)

var errMetricsWriter = errors.New("metrics writer failed")

type metricsErrorWriter struct{}

func (metricsErrorWriter) Write([]byte) (int, error) { return 0, errMetricsWriter }

type metricsPartialErrorWriter struct {
	writes      int
	writeHeader int
	status      int
}

func (w *metricsPartialErrorWriter) Header() http.Header { return make(http.Header) }
func (w *metricsPartialErrorWriter) WriteHeader(status int) {
	w.writeHeader++
	w.status = status
}
func (w *metricsPartialErrorWriter) Write(p []byte) (int, error) {
	w.writes++
	return min(len(p), 3), errMetricsWriter
}

func TestMetricsWritePrometheusReturnsWriterError(t *testing.T) {
	err := NewMetrics().WritePrometheus(metricsErrorWriter{})
	if !errors.Is(err, errMetricsWriter) {
		t.Fatalf("WritePrometheus error = %v, want writer error", err)
	}
}

func metricValue(families []*io_prometheus_client.MetricFamily, name string, labels map[string]string) float64 {
	for _, family := range families {
		if family.GetName() != name {
			continue
		}
		for _, metric := range family.GetMetric() {
			matches := true
			for _, pair := range metric.GetLabel() {
				if value, ok := labels[pair.GetName()]; !ok || value != pair.GetValue() {
					matches = false
					break
				}
			}
			if matches && len(metric.GetLabel()) == len(labels) {
				if metric.Counter != nil {
					return metric.GetCounter().GetValue()
				}
				if metric.Summary != nil {
					return metric.GetSummary().GetSampleSum()
				}
				if metric.Gauge != nil {
					return metric.GetGauge().GetValue()
				}
				if metric.Histogram != nil {
					return metric.GetHistogram().GetSampleSum()
				}
			}
		}
	}
	return 0
}

func TestMetricsDatabasePoolTracksControlledWait(t *testing.T) {
	database, err := store.OpenDatabase(t.Context(), t.TempDir()+"/metrics.db")
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := database.Close(); err != nil {
			t.Errorf("close database: %v", err)
		}
	}()
	connection, err := database.Conn(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	connectionClosed := false
	defer func() {
		if !connectionClosed {
			if err := connection.Close(); err != nil {
				t.Errorf("close connection: %v", err)
			}
		}
	}()
	queryDone := make(chan error, 1)
	go func() {
		var result int
		queryDone <- database.QueryRowContext(t.Context(), "SELECT 1").Scan(&result)
	}()
	deadline := time.Now().Add(time.Second)
	for database.Stats().WaitCount == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if got := database.Stats().WaitCount; got == 0 {
		t.Fatal("database pool did not record a controlled wait")
	}
	metrics := NewMetrics()
	authenticator, err := NewAuthenticator(AuthConfig{Mode: "none"})
	if err != nil {
		t.Fatal(err)
	}
	server, err := New(Config{
		Authenticator: authenticator, Metrics: metrics, DatabaseStats: database.Stats,
		Media: &routeTestMedia{}, Preview: routeTestPreview{}, Projects: routeTestProjects{},
		BatchExports: &routeTestBatchExports{}, Jobs: &routeTestJobs{},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := connection.Close(); err != nil {
		t.Fatal(err)
	}
	connectionClosed = true
	if err := <-queryDone; err != nil {
		t.Fatal(err)
	}
	stats := database.Stats()
	if stats.WaitDuration <= 0 {
		t.Fatalf("controlled database wait duration = %v, want positive", stats.WaitDuration)
	}
	response := httptest.NewRecorder()
	server.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), "database_pool_wait_duration_seconds") {
		t.Fatalf("metrics scrape status=%d body=%q", response.Code, response.Body.String())
	}
	families, err := metrics.registry.Gather()
	if err != nil {
		t.Fatal(err)
	}
	for name, want := range map[string]float64{
		"database_pool_wait_count":            1,
		"database_pool_wait_duration_seconds": stats.WaitDuration.Seconds(),
		"database_pool_in_use_connections":    0,
		"database_pool_open_connections":      1,
	} {
		if got := metricValue(families, name, nil); got != want {
			t.Errorf("%s = %v, want %v", name, got, want)
		}
	}
}

func TestMetricsTerminalFinalizationTracksFailuresAndLatency(t *testing.T) {
	metrics := NewMetrics()
	metrics.TerminalFinalization(250*time.Millisecond, true)
	metrics.TerminalFinalization(500*time.Millisecond, false)
	families, err := metrics.registry.Gather()
	if err != nil {
		t.Fatal(err)
	}
	if got := metricValue(families, "job_terminal_finalization_failures_total", nil); got != 1 {
		t.Fatalf("terminal failures = %v, want 1", got)
	}
	if got := metricValue(families, "job_terminal_finalization_duration_seconds", nil); got != .75 {
		t.Fatalf("terminal finalization duration = %v, want .75 seconds", got)
	}
	for _, family := range families {
		if family.GetName() == "job_terminal_finalization_duration_seconds" {
			if got := family.GetMetric()[0].GetHistogram().GetSampleCount(); got != 2 {
				t.Fatalf("terminal finalization observations = %d, want 2", got)
			}
		}
	}
}

func TestMetricsRegistriesAreIsolated(t *testing.T) {
	first, second := NewMetrics(), NewMetrics()
	first.HTTP("/api/v2/media", http.MethodGet, "2xx", 1.5)
	first.Add("ffmpeg_failures_total", 2)

	firstFamilies, err := first.registry.Gather()
	if err != nil {
		t.Fatal(err)
	}
	secondFamilies, err := second.registry.Gather()
	if err != nil {
		t.Fatal(err)
	}
	if got := metricValue(firstFamilies, "http_requests_total", map[string]string{"route": "/api/v2/media", "method": "GET", "status_class": "2xx"}); got != 1 {
		t.Fatalf("first registry request = %v, want 1", got)
	}
	if got := metricValue(firstFamilies, "ffmpeg_failures_total", nil); got != 2 {
		t.Fatalf("first registry counter = %v, want 2", got)
	}
	if got := metricValue(secondFamilies, "http_requests_total", map[string]string{"route": "/api/v2/media", "method": "GET", "status_class": "2xx"}); got != 0 {
		t.Fatalf("second registry contains first server request: %v", got)
	}
	if got := metricValue(secondFamilies, "ffmpeg_failures_total", nil); got != 0 {
		t.Fatalf("second registry contains first server counter: %v", got)
	}
}

func TestMetricsBoundsMethodsAndAggregatesLatency(t *testing.T) {
	metrics := NewMetrics()
	for i := range 100 {
		metrics.HTTP("/api/v2/unknown", fmt.Sprintf("CUSTOM%d", i), "4xx", 0.25)
	}
	metrics.HTTP("/api/v2/media", "GET", "2xx", 1)
	metrics.HTTP("/api/v2/media", "GET", "2xx", 2)
	var output bytes.Buffer
	if err := metrics.WritePrometheus(&output); err != nil {
		t.Fatal(err)
	}
	text := output.String()
	_ = text
	families, err := metrics.registry.Gather()
	if err != nil {
		t.Fatal(err)
	}
	labels := map[string]string{"method": "OTHER", "route": "/api/v2/unknown", "status_class": "4xx"}
	if got := metricValue(families, "http_requests_total", labels); got != 100 {
		t.Fatalf("OTHER counter = %v, want 100", got)
	}
	latency := map[string]string{"method": "GET", "route": "/api/v2/media", "status_class": "2xx"}
	var count uint64
	for _, family := range families {
		if family.GetName() == "http_request_duration_seconds" {
			for _, metric := range family.GetMetric() {
				if len(metric.GetLabel()) == len(latency) && metric.GetSummary().GetSampleSum() == 3 {
					count = metric.GetSummary().GetSampleCount()
				}
			}
		}
	}
	if count != 2 {
		t.Fatalf("duration observation count = %d, want 2", count)
	}
	if strings.Contains(text, "CUSTOM") {
		t.Fatalf("unbounded method labels in metrics:\n%s", text)
	}
}

func TestMetricsUnknownPathsUseFixedRouteLabel(t *testing.T) {
	for _, path := range []string{"/api/v2/arbitrary/one", "/api/v2/arbitrary/two", "/media/v2/arbitrary/one", "/elsewhere/one", "/elsewhere/two"} {
		label := routeFor(path)
		if strings.Contains(label, "arbitrary") || strings.Contains(label, "elsewhere") {
			t.Errorf("routeFor(%q) = %q, contains input path", path, label)
		}
	}
	if routeFor("/api/v2/arbitrary/one") != routeFor("/api/v2/arbitrary/two") || routeFor("/elsewhere/one") != routeFor("/elsewhere/two") {
		t.Fatal("unknown paths did not collapse to fixed labels")
	}
}

func TestMetricsHandlerDoesNotRewriteWriterFailure(t *testing.T) {
	auth, err := NewAuthenticator(AuthConfig{Mode: "none"})
	if err != nil {
		t.Fatal(err)
	}
	server, err := New(Config{Authenticator: auth, Metrics: NewMetrics(), Media: &routeTestMedia{}, Preview: routeTestPreview{}, Projects: routeTestProjects{}, BatchExports: &routeTestBatchExports{}, Jobs: &routeTestJobs{}})
	if err != nil {
		t.Fatal(err)
	}
	writer := &metricsPartialErrorWriter{}
	request := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	server.ServeHTTP(writer, request)
	if writer.writes != 1 {
		t.Fatalf("Write calls = %d, want one partial metrics write", writer.writes)
	}
	if writer.writeHeader != 1 || writer.status != http.StatusOK {
		t.Fatalf("committed headers = %d with status %d, want one 200 response", writer.writeHeader, writer.status)
	}
}

func TestMetricsRequiresDeploymentAuthentication(t *testing.T) {
	auth, err := NewAuthenticator(AuthConfig{Mode: "bearer", BearerToken: "private-metrics-token-0123456789abcdef"})
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
		{"private-metrics-token-0123456789abcdef", http.StatusOK},
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
