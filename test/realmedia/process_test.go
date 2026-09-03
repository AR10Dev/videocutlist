//go:build realmedia

package realmedia

import (
	"net/http"
	"testing"
)

func TestProductionProcessStartsAndIndexesFixture(t *testing.T) {
	p := startProcess(t, t.TempDir())
	for _, path := range []string{"/api/v1/health", "/api/v1/media/status", "/api/v1/media"} {
		resp := p.request(t, http.MethodGet, path)
		if resp.StatusCode != http.StatusOK {
			resp.Body.Close()
			t.Fatalf("GET %s status=%d", path, resp.StatusCode)
		}
		resp.Body.Close()
	}
}
