package httpapi

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type containerDownload struct{ name string }

func (d containerDownload) Download(context.Context, string, int) (io.ReadCloser, string, error) {
	return io.NopCloser(strings.NewReader("artifact")), d.name, nil
}

func TestDownloadOutputUsesContainerMIME(t *testing.T) {
	for _, test := range []struct {
		name string
		mime string
	}{
		{"clip.mkv", "video/x-matroska"},
		{"clip.mp4", "video/mp4"},
		{"clip.mov", "video/quicktime"},
	} {
		t.Run(test.name, func(t *testing.T) {
			server := &Server{config: Config{Download: containerDownload{name: test.name}}}
			response := httptest.NewRecorder()
			server.downloadOutput(response, httptest.NewRequest(http.MethodGet, "/", nil), "j_aaaaaaaaaaaa:0", "request")
			if response.Code != http.StatusOK || response.Header().Get("Content-Type") != test.mime || response.Body.String() != "artifact" {
				t.Fatalf("response = %d %q %q", response.Code, response.Header().Get("Content-Type"), response.Body.String())
			}
		})
	}
}
