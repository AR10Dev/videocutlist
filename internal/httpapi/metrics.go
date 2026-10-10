package httpapi

import (
	"fmt"
	"io"
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/common/expfmt"
)

// Metrics owns a per-server registry; labels are bounded at the HTTP boundary.
type Metrics struct {
	registry  *prometheus.Registry
	http      *prometheus.CounterVec
	durations *prometheus.SummaryVec
	preview   *prometheus.CounterVec
	counters  map[string]prometheus.Counter
}

func NewMetrics() *Metrics {
	m := &Metrics{
		registry: prometheus.NewRegistry(),
		http: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "http_requests_total", Help: "HTTP requests by normalized route, method and status class.",
		}, []string{"route", "method", "status_class"}),
		durations: prometheus.NewSummaryVec(prometheus.SummaryOpts{
			Name: "http_request_duration_seconds", Help: "HTTP request duration in seconds.",
		}, []string{"route", "method", "status_class"}),
		preview: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "preview_requests_total", Help: "Preview requests by cache status.",
		}, []string{"cache_status"}),
		counters: make(map[string]prometheus.Counter),
	}
	m.registry.MustRegister(m.http, m.durations, m.preview)
	for _, name := range []string{"preview_cache_hits_total", "preview_cache_misses_total", "ffmpeg_failures_total", "export_jobs_total"} {
		counter := prometheus.NewCounter(prometheus.CounterOpts{Name: name, Help: name})
		m.registry.MustRegister(counter)
		m.counters[name] = counter
	}
	return m
}

func (m *Metrics) HTTP(route, method, statusClass string, seconds float64) {
	switch method {
	case http.MethodGet, http.MethodHead, http.MethodPost, http.MethodPut,
		http.MethodPatch, http.MethodDelete, http.MethodConnect, http.MethodOptions, http.MethodTrace:
	default:
		method = "OTHER"
	}
	m.http.WithLabelValues(route, method, statusClass).Inc()
	m.durations.WithLabelValues(route, method, statusClass).Observe(seconds)
}

func (m *Metrics) Preview(cache string) {
	m.preview.WithLabelValues(cache).Inc()
	if cache == "hit" {
		m.counters["preview_cache_hits_total"].Inc()
	}
	if cache == "miss" {
		m.counters["preview_cache_misses_total"].Inc()
	}
}

func (m *Metrics) Add(name string, amount uint64) {
	if counter, ok := m.counters[name]; ok {
		counter.Add(float64(amount))
	}
}

// WritePrometheus gathers only this server's collectors and writes the standard
// text format without changing the existing metric names or summary series.
func (m *Metrics) WritePrometheus(writer io.Writer) error {
	families, err := m.registry.Gather()
	if err != nil {
		return fmt.Errorf("gather prometheus metrics: %w", err)
	}
	for _, family := range families {
		if _, err := expfmt.MetricFamilyToText(writer, family); err != nil {
			return fmt.Errorf("write prometheus metrics: %w", err)
		}
	}
	return nil
}
