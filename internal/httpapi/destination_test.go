package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDestinationCapabilitiesAreSafeAndDefaultDisabled(t *testing.T) {
	authenticator, err := NewAuthenticator(AuthConfig{Mode: "none"})
	if err != nil {
		t.Fatal(err)
	}
	server, err := New(Config{
		Authenticator: authenticator,
		Media:         &routeTestMedia{},
		Preview:       routeTestPreview{},
		Projects:      routeTestProjects{},
		BatchExports:  &routeTestBatchExports{},
		Jobs:          &routeTestJobs{},
		Destinations:  []DestinationMetadata{{ID: "beside", Label: "Beside source", Kind: "source_adjacent", Retention: "durable"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodGet, "/api/v1/destinations", nil)
	response := httptest.NewRecorder()
	server.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	var body struct {
		Capabilities DestinationCapabilities `json:"capabilities"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if !body.Capabilities.SaveBesideSource {
		t.Fatal("explicit source-adjacent destination was not reported")
	}
	if strings.Contains(response.Body.String(), "/") || strings.Contains(response.Body.String(), "\\") {
		t.Fatalf("destination response contains a filesystem path: %s", response.Body.String())
	}

	server.config.Destinations = nil
	response = httptest.NewRecorder()
	server.ServeHTTP(response, request)
	if response.Code != http.StatusOK || strings.Contains(response.Body.String(), `"saveBesideSource":true`) {
		t.Fatalf("default capability response = %s", response.Body.String())
	}
}
