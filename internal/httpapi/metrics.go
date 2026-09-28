// Package metrics exports the small fixed Prometheus surface used by the API.
package httpapi

import (
	"fmt"
	"io"
	"maps"
	"net/http"
	"slices"
	"strings"
	"sync"
)

type Metrics struct {
	mu        sync.Mutex
	http      map[string]uint64
	durations map[string]float64
	preview   map[string]uint64
	counters  map[string]uint64
}

func NewMetrics() *Metrics {
	return &Metrics{
		http:      map[string]uint64{},
		durations: map[string]float64{},
		preview:   map[string]uint64{},
		counters: map[string]uint64{
			"preview_cache_hits_total":   0,
			"preview_cache_misses_total": 0,
			"ffmpeg_failures_total":      0,
			"export_jobs_total":          0,
		},
	}
}

func (m *Metrics) HTTP(route, method, statusClass string, seconds float64) {
	switch method {
	case http.MethodGet, http.MethodHead, http.MethodPost, http.MethodPut,
		http.MethodPatch, http.MethodDelete, http.MethodConnect, http.MethodOptions, http.MethodTrace:
	default:
		method = "OTHER"
	}
	m.mu.Lock()
	key := route + "\x00" + method + "\x00" + statusClass
	m.http[key]++
	m.durations[key] += seconds
	m.mu.Unlock()
}

func (m *Metrics) Preview(cache string) {
	m.mu.Lock()
	m.preview[cache]++
	if cache == "hit" {
		m.counters["preview_cache_hits_total"]++
	}
	if cache == "miss" {
		m.counters["preview_cache_misses_total"]++
	}
	m.mu.Unlock()
}

func (m *Metrics) Add(name string, amount uint64) {
	m.mu.Lock()
	m.counters[name] += amount
	m.mu.Unlock()
}

func (m *Metrics) WritePrometheus(writer io.Writer) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	var output []byte
	for _, name := range []string{"http_requests_total", "preview_requests_total", "preview_cache_hits_total", "preview_cache_misses_total", "ffmpeg_failures_total", "export_jobs_total"} {
		output = fmt.Appendf(output, "# TYPE %s counter\n", name)
	}
	output = append(output, "# TYPE http_request_duration_seconds summary\n"...)
	keys := sorted(m.http)
	for _, key := range keys {
		parts := strings.Split(key, "\x00")
		output = fmt.Appendf(output, "http_requests_total{route=%q,method=%q,status_class=%q} %d\n", parts[0], parts[1], parts[2], m.http[key])
		output = fmt.Appendf(output, "http_request_duration_seconds_sum{route=%q,method=%q,status_class=%q} %g\n", parts[0], parts[1], parts[2], m.durations[key])
		output = fmt.Appendf(output, "http_request_duration_seconds_count{route=%q,method=%q,status_class=%q} %d\n", parts[0], parts[1], parts[2], m.http[key])
	}
	keys = sorted(m.preview)
	for _, key := range keys {
		output = fmt.Appendf(output, "preview_requests_total{cache_status=%q} %d\n", key, m.preview[key])
	}
	keys = sorted(m.counters)
	for _, key := range keys {
		output = fmt.Appendf(output, "%s %d\n", key, m.counters[key])
	}
	n, err := writer.Write(output)
	if err != nil {
		return fmt.Errorf("write prometheus metrics: %w", err)
	}
	if n != len(output) {
		return io.ErrShortWrite
	}
	return nil
}

func sorted(values map[string]uint64) []string { return slices.Sorted(maps.Keys(values)) }
