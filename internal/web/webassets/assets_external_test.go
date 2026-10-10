//go:build !embed_frontend

package webassets

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestDefaultHandlerServesWebDist(t *testing.T) {
	root := t.TempDir()
	t.Chdir(root)
	dist := filepath.Join("web", "dist")
	if err := os.MkdirAll(dist, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dist, "index.html"), []byte("workspace"), 0600); err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	DefaultHandler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/editor", nil))
	if rec.Code != http.StatusOK || rec.Body.String() != "workspace" {
		t.Fatalf("development frontend: status=%d body=%q", rec.Code, rec.Body.String())
	}
}
