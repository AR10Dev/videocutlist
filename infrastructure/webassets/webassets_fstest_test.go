package webassets

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"testing/fstest"
)

func TestHandlerFSRootFallbackAndHeaders(t *testing.T) {
	assets := fstest.MapFS{
		"index.html":  &fstest.MapFile{Data: []byte("index")},
		"app.js":      &fstest.MapFile{Data: []byte("js")},
		"app.js.br":   &fstest.MapFile{Data: []byte("br")},
		"app.js.gz":   &fstest.MapFile{Data: []byte("gzip")},
		"nested/page": &fstest.MapFile{Data: []byte("page")},
	}
	server := HandlerFS(assets)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/app.js", nil)
	req.Header.Set("Accept-Encoding", "gzip, br")
	server.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || rec.Body.String() != "br" || rec.Header().Get("Content-Encoding") != "br" || rec.Header().Get("Vary") != "Accept-Encoding" {
		t.Fatalf("compressed response: code=%d body=%q headers=%v", rec.Code, rec.Body.String(), rec.Header())
	}
	if got := rec.Header().Get("Cache-Control"); got != "public, max-age=31536000, immutable" {
		t.Fatalf("asset cache=%q", got)
	}
	if got := rec.Header().Get("Content-Type"); got == "" {
		t.Fatal("asset has no MIME type")
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/app.js", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	server.ServeHTTP(rec, req)
	if rec.Header().Get("Content-Encoding") != "gzip" || rec.Body.String() != "gzip" {
		t.Fatalf("gzip response: encoding=%q body=%q", rec.Header().Get("Content-Encoding"), rec.Body.String())
	}

	rec = httptest.NewRecorder()
	server.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/editor", nil))
	if rec.Code != http.StatusOK || rec.Body.String() != "index" || rec.Header().Get("Cache-Control") != "no-cache" {
		t.Fatalf("SPA fallback: code=%d body=%q cache=%q", rec.Code, rec.Body.String(), rec.Header().Get("Cache-Control"))
	}

	rec = httptest.NewRecorder()
	server.ServeHTTP(rec, httptest.NewRequest(http.MethodHead, "/app.js", nil))
	if rec.Code != http.StatusOK || rec.Body.Len() != 0 {
		t.Fatalf("HEAD: code=%d body=%q", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	server.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/app.js", nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST status=%d", rec.Code)
	}

}
