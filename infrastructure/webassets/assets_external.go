//go:build !embed_frontend

package webassets

import "net/http"

// DefaultHandler serves the generated client files from disk for development.
func DefaultHandler() http.Handler { return Handler("client/dist") }
