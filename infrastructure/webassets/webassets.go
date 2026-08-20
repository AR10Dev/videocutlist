// Package webassets serves a Vite build with cache-safe precompressed assets.
package webassets

import (
	"mime"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
)

// Handler serves a Vite dist directory. Fingerprinted assets are immutable;
// index.html remains revalidated so deployments can discover new asset names.
func Handler(root string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		name := path.Clean("/" + r.URL.Path)
		if name == "/" {
			name = "/index.html"
		}
		file := filepath.Join(root, filepath.FromSlash(strings.TrimPrefix(name, "/")))
		if info, err := os.Stat(file); err != nil || info.IsDir() {
			file = filepath.Join(root, "index.html")
			name = "/index.html"
		}
		encoding := ""
		for _, candidate := range []struct{ suffix, encoding string }{{".br", "br"}, {".gz", "gzip"}} {
			if strings.Contains(r.Header.Get("Accept-Encoding"), candidate.encoding) {
				if _, err := os.Stat(file + candidate.suffix); err == nil {
					file, encoding = file+candidate.suffix, candidate.encoding
					break
				}
			}
		}
		if encoding != "" {
			w.Header().Set("Content-Encoding", encoding)
			w.Header().Set("Vary", "Accept-Encoding")
		}
		if name == "/index.html" {
			w.Header().Set("Cache-Control", "no-cache")
		} else {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		}
		if contentType := mime.TypeByExtension(filepath.Ext(name)); contentType != "" {
			w.Header().Set("Content-Type", contentType)
		}
		http.ServeFile(w, r, file)
	})
}
