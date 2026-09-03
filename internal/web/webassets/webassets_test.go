package webassets

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestHandlerUsesCompressedImmutableAssetsAndSPAIndex(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "index.html"), []byte("index"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "app-abc.js"), []byte("js"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "app-abc.js.br"), []byte("br"), 0600); err != nil {
		t.Fatal(err)
	}
	h := Handler(dir)
	req := httptest.NewRequest(http.MethodGet, "/app-abc.js", nil)
	req.Header.Set("Accept-Encoding", "br, gzip")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || rec.Header().Get("Content-Encoding") != "br" || rec.Header().Get("Cache-Control") != "public, max-age=31536000, immutable" {
		t.Fatalf("status=%d encoding=%q cache=%q", rec.Code, rec.Header().Get("Content-Encoding"), rec.Header().Get("Cache-Control"))
	}
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/editor", nil))
	if rec.Code != http.StatusOK || rec.Header().Get("Cache-Control") != "no-cache" {
		t.Fatalf("SPA status=%d cache=%q", rec.Code, rec.Header().Get("Cache-Control"))
	}
}
