//go:build embed_frontend

package webassets

import (
	"embed"
	"io/fs"
	"net/http"
)

// The release build copies client/dist here before compiling with embed_frontend.
//
//go:embed dist
var embeddedAssets embed.FS

// DefaultHandler serves the frontend embedded in the Go binary.
func DefaultHandler() http.Handler {
	assets, err := fs.Sub(embeddedAssets, "dist")
	if err != nil {
		panic(err)
	}
	return HandlerFS(assets)
}
