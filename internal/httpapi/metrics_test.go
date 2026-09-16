package httpapi

import (
	"errors"
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
