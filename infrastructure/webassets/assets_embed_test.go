//go:build embed_frontend

package webassets

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestDefaultHandlerServesEmbeddedFrontend(t *testing.T) {
	rec := httptest.NewRecorder()
	DefaultHandler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	if rec.Code != http.StatusOK || rec.Body.Len() == 0 {
		t.Fatalf("embedded frontend: status=%d body=%d", rec.Code, rec.Body.Len())
	}
}
