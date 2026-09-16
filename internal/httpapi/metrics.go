// Package metrics exports the small fixed Prometheus surface used by the API.
package httpapi

import (
	"fmt"
	"io"
	"maps"
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
	gauges    map[string]float64
}

func NewMetrics() *Metrics {
	return &Metrics{
		http:      map[string]uint64{},
		durations: map[string]float64{},
		preview:   map[string]uint64{},
		counters: map[string]uint64{
			"preview_cache_hits_total":     0,
			"preview_cache_misses_total":   0,
			"preview_bytes_streamed_total": 0,
			"ffmpeg_failures_total":        0,
			"preview_cancellations_total":  0,
			"export_jobs_total":            0,
			"cache_evictions_total":        0,
		},
		gauges: map[string]float64{
			"preview_jobs_active":                 0,
			"preview_queue_depth":                 0,
			"preview_time_to_first_byte_seconds":  0,
			"preview_generation_duration_seconds": 0,
			"export_jobs_active":                  0,
			"cache_bytes":                         0,
		},
	}
}

func (m *Metrics) HTTP(route, method, statusClass string, seconds float64) {
	m.mu.Lock()
	key := route + "\x00" + method + "\x00" + statusClass
	m.http[key]++
	m.durations[key] = seconds
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
func (m *Metrics) Set(name string, value float64) { m.mu.Lock(); m.gauges[name] = value; m.mu.Unlock() }

func (m *Metrics) WritePrometheus(writer io.Writer) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	var output []byte
	for _, name := range []string{"http_requests_total", "http_request_duration_seconds", "preview_requests_total", "preview_cache_hits_total", "preview_cache_misses_total", "preview_jobs_active", "preview_queue_depth", "preview_time_to_first_byte_seconds", "preview_generation_duration_seconds", "preview_bytes_streamed_total", "ffmpeg_failures_total", "preview_cancellations_total", "export_jobs_active", "export_jobs_total", "cache_bytes", "cache_evictions_total"} {
		output = fmt.Appendf(output, "# TYPE %s %s\n", name, metricType(name))
	}
	keys := sorted(m.http)
	for _, key := range keys {
		parts := strings.Split(key, "\x00")
		output = fmt.Appendf(output, "http_requests_total{route=%q,method=%q,status_class=%q} %d\n", parts[0], parts[1], parts[2], m.http[key])
		output = fmt.Appendf(output, "http_request_duration_seconds{route=%q,method=%q,status_class=%q} %g\n", parts[0], parts[1], parts[2], m.durations[key])
	}
	keys = sorted(m.preview)
	for _, key := range keys {
		output = fmt.Appendf(output, "preview_requests_total{cache_status=%q} %d\n", key, m.preview[key])
	}
	keys = sorted(m.counters)
	for _, key := range keys {
		output = fmt.Appendf(output, "%s %d\n", key, m.counters[key])
	}
	keys = sortedFloat(m.gauges)
	for _, key := range keys {
		output = fmt.Appendf(output, "%s %g\n", key, m.gauges[key])
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

func metricType(name string) string {
	if strings.HasSuffix(name, "_total") {
		return "counter"
	}
	return "gauge"
}
func sorted(values map[string]uint64) []string { return slices.Sorted(maps.Keys(values)) }
func sortedFloat(values map[string]float64) []string {
	return slices.Sorted(maps.Keys(values))
}
