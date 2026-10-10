//go:build !embed_frontend

package webassets

import "net/http"

// DefaultHandler serves the generated frontend files from disk for development.
func DefaultHandler() http.Handler { return Handler("web/dist") }
