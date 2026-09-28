package webassets

import (
	"io"
	"io/fs"
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

func TestHandlerReadsCurrentDevelopmentFiles(t *testing.T) {
	dir := t.TempDir()
	index := filepath.Join(dir, "index.html")
	if err := os.WriteFile(index, []byte("before"), 0600); err != nil {
		t.Fatal(err)
	}
	h := Handler(dir)
	for _, want := range []string{"before", "after"} {
		if want == "after" {
			if err := os.WriteFile(index, []byte(want), 0600); err != nil {
				t.Fatal(err)
			}
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/editor", nil))
		if rec.Code != http.StatusOK || rec.Body.String() != want {
			t.Fatalf("SPA after file edit: status=%d body=%q want=%q", rec.Code, rec.Body.String(), want)
		}
	}
}

type trackingFS struct {
	root   fs.FS
	reads  map[string]int
	closes map[string]int
}

func (t *trackingFS) Open(name string) (fs.File, error) {
	file, err := t.root.Open(name)
	if err != nil {
		return nil, err
	}
	return &trackingFile{File: file, owner: t, name: name}, nil
}

type trackingFile struct {
	fs.File
	owner *trackingFS
	name  string
}

func (f *trackingFile) Read(p []byte) (int, error) {
	n, err := f.File.Read(p)
	f.owner.reads[f.name] += n
	return n, err
}

func (f *trackingFile) Seek(offset int64, whence int) (int64, error) {
	return f.File.(io.Seeker).Seek(offset, whence)
}

func (f *trackingFile) Close() error {
	f.owner.closes[f.name]++
	return f.File.Close()
}

func TestHandlerStreamsOnlyRequestedRepresentationAndRange(t *testing.T) {
	dir := t.TempDir()
	for name, data := range map[string]string{
		"app.js":    "identity representation",
		"app.js.br": "compressed representation",
	} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(data), 0600); err != nil {
			t.Fatal(err)
		}
	}
	assets := &trackingFS{root: os.DirFS(dir), reads: make(map[string]int), closes: make(map[string]int)}
	h := HandlerFS(assets)

	req := httptest.NewRequest(http.MethodGet, "/app.js", nil)
	req.Header.Set("Accept-Encoding", "br")
	req.Header.Set("Range", "bytes=3-5")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusPartialContent || rec.Body.String() != "pre" ||
		rec.Header().Get("Content-Encoding") != "br" || rec.Header().Get("Content-Range") != "bytes 3-5/25" {
		t.Fatalf("partial compressed response: status=%d body=%q headers=%v", rec.Code, rec.Body.String(), rec.Header())
	}
	if assets.reads["app.js"] != 0 || assets.reads["app.js.br"] != 3 {
		t.Fatalf("range read full asset: %#v", assets.reads)
	}

	req = httptest.NewRequest(http.MethodHead, "/app.js", nil)
	req.Header.Set("Accept-Encoding", "br")
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || rec.Body.Len() != 0 || assets.reads["app.js.br"] != 3 {
		t.Fatalf("HEAD read body: status=%d body=%q reads=%v", rec.Code, rec.Body.String(), assets.reads)
	}

	req = httptest.NewRequest(http.MethodGet, "/app.js", nil)
	req.Header.Set("Accept-Encoding", "br")
	req.Header.Set("If-Modified-Since", rec.Header().Get("Last-Modified"))
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotModified || assets.reads["app.js.br"] != 3 {
		t.Fatalf("conditional GET read body: status=%d reads=%v", rec.Code, assets.reads)
	}
	if assets.closes["app.js"] != 3 || assets.closes["app.js.br"] != 3 {
		t.Fatalf("compressed requests leaked descriptors: %#v", assets.closes)
	}
}
