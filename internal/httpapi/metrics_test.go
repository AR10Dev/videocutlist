package httpapi

import (
	"bytes"
	"errors"
	"fmt"
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
