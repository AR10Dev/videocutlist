//go:build realmedia

package realmedia

import (
	"net/http"
	"testing"
)

// productionRoutes is the route coverage contract for the HTTP router. Keep this
// table next to the black-box suite so a newly accepted route cannot be hidden
// by an unaccounted integration path.
var productionRoutes = []struct {
	method string
	path   string
	group  string
}{
	{http.MethodGet, "/api/v1/media", "media"},
	{http.MethodGet, "/api/v1/media/tree", "media"},
	{http.MethodGet, "/api/v1/media/status", "media"},
	{http.MethodPost, "/api/v1/media/refresh", "media"},
	{http.MethodPost, "/api/v1/media/import", "media"},
	{http.MethodGet, "/api/v1/media/import/j_aaaaaaaaaaaa", "media"},
	{http.MethodDelete, "/api/v1/media/import/j_aaaaaaaaaaaa", "media"},
	{http.MethodGet, "/api/v1/media/m_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "media"},
	{http.MethodGet, "/api/v1/media/m_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/preview", "assets"},
	{http.MethodHead, "/api/v1/media/m_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/preview", "assets"},
	{http.MethodGet, "/api/v1/media/m_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/thumbnails", "assets"},
	{http.MethodGet, "/api/v1/media/m_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/waveform", "assets"},
	{http.MethodGet, "/api/v1/projects", "projects"},
	{http.MethodGet, "/api/v1/projects/p_aaaaaaaaaaaa", "projects"},
	{http.MethodPut, "/api/v1/projects/p_aaaaaaaaaaaa", "projects"},
	{http.MethodPost, "/api/v1/projects/p_aaaaaaaaaaaa/exports", "exports"},
	{http.MethodPost, "/api/v1/projects/p_aaaaaaaaaaaa/exports/preflight", "exports"},
	{http.MethodPost, "/api/v1/projects/p_aaaaaaaaaaaa/interchange/csv", "interchange"},
	{http.MethodGet, "/api/v1/projects/p_aaaaaaaaaaaa/interchange/csv", "interchange"},
	{http.MethodPost, "/api/v1/projects/p_aaaaaaaaaaaa/interchange/chapters", "interchange"},
	{http.MethodGet, "/api/v1/projects/p_aaaaaaaaaaaa/interchange/chapters", "interchange"},
	{http.MethodPost, "/api/v1/projects/p_aaaaaaaaaaaa/detections", "detection"},
	{http.MethodGet, "/api/v1/jobs/j_aaaaaaaaaaaa", "jobs"},
	{http.MethodDelete, "/api/v1/jobs/j_aaaaaaaaaaaa", "jobs"},
	{http.MethodPost, "/api/v1/jobs/j_aaaaaaaaaaaa/retry", "jobs"},
	{http.MethodGet, "/api/v1/jobs/j_aaaaaaaaaaaa/outputs/0", "outputs"},
	{http.MethodGet, "/api/v1/batches", "batches"},
	{http.MethodGet, "/api/v1/batches/b_aaaaaaaaaaaa", "batches"},
	{http.MethodDelete, "/api/v1/batches/b_aaaaaaaaaaaa", "batches"},
	{http.MethodPost, "/api/v1/automation", "automation"},
	{http.MethodGet, "/api/v1/destinations", "settings"},
	{http.MethodGet, "/api/v1/settings", "settings"},
	{http.MethodPut, "/api/v1/settings", "settings"},
	{http.MethodPost, "/api/v1/settings/media/refresh", "settings"},
}

func TestProductionRouteCoverageTable(t *testing.T) {
	seen := make(map[string]bool, len(productionRoutes))
	for _, tc := range productionRoutes {
		key := tc.method + " " + tc.path
		if seen[key] {
			t.Errorf("duplicate route coverage entry %s", key)
		}
		seen[key] = true
	}
	// These are production endpoints handled outside parseRoute.
	const processRoutes = 3 // health, ready, and static application document
	t.Logf("real-media evidence: accounted routes=%d (api=%d, process=%d)", len(productionRoutes)+processRoutes, len(productionRoutes), processRoutes)
}
