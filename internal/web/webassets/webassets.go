// Package webassets serves a Vite build with cache-safe precompressed assets.
package webassets

import (
	"bytes"
	"io"
	"io/fs"
	"mime"
	"net/http"
	"os"
	"path"
	"strconv"
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
		file, asset, info, ok := openAsset(assets, name)
		if !ok {
			name = "index.html"
			file, asset, info, ok = openAsset(assets, name)
		}
		if !ok {
			http.NotFound(w, r)
			return
		}
		defer func(original fs.File) { _ = original.Close() }(asset)
		encoding := ""
		qualities, explicitIdentity := acceptedEncodings(r.Header.Get("Accept-Encoding"))
		candidates := [2]struct{ suffix, encoding string }{{".br", "br"}, {".gz", "gzip"}}
		order := [2]int{0, 1}
		if qualities[1] > qualities[0] {
			order = [2]int{1, 0}
		}
		for _, index := range order {
			candidate := candidates[index]
			if qualities[index] <= 0 || explicitIdentity && qualities[2] > qualities[index] {
				continue
			}
			if _, compressed, compressedInfo, found := openAsset(assets, file+candidate.suffix); found {
				defer func(file fs.File) { _ = file.Close() }(compressed)
				asset, info, encoding = compressed, compressedInfo, candidate.encoding
				break
			}
		}
		w.Header().Add("Vary", "Accept-Encoding")
		if encoding != "" {
			w.Header().Set("Content-Encoding", encoding)
		} else if qualities[2] == 0 {
			http.Error(w, "no acceptable asset encoding", http.StatusNotAcceptable)
			return
		}
		if name == "index.html" {
			w.Header().Set("Cache-Control", "no-cache")
		} else {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		}
		if contentType := mime.TypeByExtension(path.Ext(name)); contentType != "" {
			w.Header().Set("Content-Type", contentType)
		}
		if seeker, ok := asset.(io.ReadSeeker); ok {
			http.ServeContent(w, r, name, info.ModTime(), seeker)
			return
		}
		// Most filesystems (including os.DirFS and embed.FS) support seeking.
		// Keep a fallback for other fs.FS implementations without reading twice.
		data, err := io.ReadAll(asset)
		if err != nil {
			http.Error(w, "asset unavailable", http.StatusInternalServerError)
			return
		}
		http.ServeContent(w, r, name, info.ModTime(), bytes.NewReader(data))
	})
}

// Parse once for the two precompressed representations and identity. Explicit
// exclusions override wildcards; omitted identity remains an acceptable fallback.
func acceptedEncodings(header string) (qualities [3]float64, explicitIdentity bool) {
	qualities[2] = 1
	var specified [3]bool
	wildcard := -1.0
	for entry := range strings.SplitSeq(header, ",") {
		coding, parameters, _ := strings.Cut(entry, ";")
		quality := 1.0
		for parameter := range strings.SplitSeq(parameters, ";") {
			name, value, found := strings.Cut(strings.TrimSpace(parameter), "=")
			if found && strings.EqualFold(name, "q") {
				parsed, err := strconv.ParseFloat(strings.TrimSpace(value), 64)
				if err != nil || !(parsed >= 0 && parsed <= 1) {
					quality = 0
				} else {
					quality = parsed
				}
				break
			}
		}
		switch strings.ToLower(strings.TrimSpace(coding)) {
		case "br":
			qualities[0], specified[0] = quality, true
		case "gzip":
			qualities[1], specified[1] = quality, true
		case "identity":
			qualities[2], specified[2] = quality, true
		case "*":
			wildcard = quality
		}
	}
	if wildcard >= 0 {
		for index := range 2 {
			if !specified[index] {
				qualities[index] = wildcard
			}
		}
		if wildcard == 0 && !specified[2] {
			qualities[2] = 0
		}
	}
	return qualities, specified[2]
}

func openAsset(assets fs.FS, name string) (string, fs.File, fs.FileInfo, bool) {
	name = path.Clean(name)
	if name == "." || strings.HasPrefix(name, "../") {
		return "", nil, nil, false
	}
	file, err := assets.Open(name)
	if err != nil {
		return "", nil, nil, false
	}
	info, err := file.Stat()
	if err != nil || info.IsDir() {
		_ = file.Close()
		return "", nil, nil, false
	}
	return name, file, info, true
}
