// Package webassets serves a Vite build with cache-safe precompressed assets.
package webassets

import (
	"bytes"
	"io/fs"
	"mime"
	"net/http"
	"os"
	"path"
	"strings"
)

// Handler serves assets from a filesystem rooted at root for local development.
func Handler(root string) http.Handler { return HandlerFS(os.DirFS(root)) }

// HandlerFS serves a Vite dist filesystem. Fingerprinted assets are immutable;
// index.html remains revalidated so deployments can discover new asset names.
func HandlerFS(assets fs.FS) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		name := path.Clean(strings.TrimPrefix(r.URL.Path, "/"))
		if name == "." || name == "" {
			name = "index.html"
		}
		file, info, data, ok := readAsset(assets, name)
		if !ok {
			name = "index.html"
			file, info, data, ok = readAsset(assets, name)
		}
		if !ok {
			http.NotFound(w, r)
			return
		}
		encoding := ""
		for _, candidate := range []struct{ suffix, encoding string }{{".br", "br"}, {".gz", "gzip"}} {
			if strings.Contains(r.Header.Get("Accept-Encoding"), candidate.encoding) {
				if compressed, compressedInfo, compressedData, found := readAsset(assets, file+candidate.suffix); found {
					file, info, data, encoding = compressed, compressedInfo, compressedData, candidate.encoding
					break
				}
			}
		}
		if encoding != "" {
			w.Header().Set("Content-Encoding", encoding)
			w.Header().Set("Vary", "Accept-Encoding")
		}
		if name == "index.html" {
			w.Header().Set("Cache-Control", "no-cache")
		} else {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		}
		if contentType := mime.TypeByExtension(path.Ext(name)); contentType != "" {
			w.Header().Set("Content-Type", contentType)
		}
		http.ServeContent(w, r, name, info.ModTime(), bytes.NewReader(data))
	})
}

func readAsset(assets fs.FS, name string) (string, fs.FileInfo, []byte, bool) {
	name = path.Clean(name)
	if name == "." || strings.HasPrefix(name, "../") {
		return "", nil, nil, false
	}
	info, err := fs.Stat(assets, name)
	if err != nil || info.IsDir() {
		return "", nil, nil, false
	}
	data, err := fs.ReadFile(assets, name)
	if err != nil {
		return "", nil, nil, false
	}
	return name, info, data, true
}
