package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"videocutlist/internal/db"
	"videocutlist/internal/mcp"
)

func TestMCPAdministrationRequiresDeploymentAuthAndRevealsSecretOnce(t *testing.T) {
	database, err := store.OpenDatabase(t.Context(), t.TempDir()+"/mcp-settings.db")
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	runtimeSettings, err := store.NewRuntimeSettingsStore(database)
	if err != nil {
		t.Fatal(err)
	}
	record, err := runtimeSettings.Seed(t.Context(), testRuntimeSettings())
	if err != nil {
		t.Fatal(err)
	}
	credentials, err := mcp.NewCredentialStore(database)
	if err != nil {
		t.Fatal(err)
	}
	authenticator, err := NewAuthenticator(AuthConfig{Mode: "bearer", BearerToken: "deployment-admin"})
	if err != nil {
		t.Fatal(err)
	}
	server, err := New(Config{
		Authenticator: authenticator, Media: &routeTestMedia{}, Preview: routeTestPreview{},
		Projects: routeTestProjects{}, BatchExports: &routeTestBatchExports{}, Jobs: &routeTestJobs{},
		Settings: runtimeSettings, RuntimeSettings: store.NewRuntimeSettingsState(record.Settings), MCPCredentials: credentials,
	})
	if err != nil {
		t.Fatal(err)
	}

	expires := time.Now().UTC().Add(time.Hour).Format(time.RFC3339Nano)
	invalidRoot := `{"name":"assistant","permissions":["media:read"],"mediaScope":{"kind":"roots","rootIds":["unknown-root"]},"projectScope":{"kind":"all"},"expiresAt":"` + expires + `"}`
	invalidRootResponse := mcpAdminRequest(server, http.MethodPost, "/api/v1/settings/mcp/credentials", invalidRoot, "deployment-admin")
	if invalidRootResponse.Code != http.StatusUnprocessableEntity {
		t.Fatalf("unknown root status=%d body=%s", invalidRootResponse.Code, invalidRootResponse.Body.String())
	}

	body := `{"name":"assistant","permissions":["media:read","exports:run"],"mediaScope":{"kind":"all"},"projectScope":{"kind":"all"},"expiresAt":"` + expires + `","unattendedExports":true}`
	createdResponse := mcpAdminRequest(server, http.MethodPost, "/api/v1/settings/mcp/credentials", body, "deployment-admin")
	if createdResponse.Code != http.StatusCreated {
		t.Fatalf("create status=%d body=%s", createdResponse.Code, createdResponse.Body.String())
	}
	var created mcp.CreatedCredential
	if err := json.Unmarshal(createdResponse.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(created.Secret, "vcl_") || created.Name != "assistant" {
		t.Fatalf("created credential=%#v", created)
	}

	for name, token := range map[string]string{"missing": "", "scoped MCP credential": created.Secret} {
		t.Run(name+" cannot administer", func(t *testing.T) {
			response := mcpAdminRequest(server, http.MethodGet, "/api/v1/settings/mcp", "", token)
			if response.Code != http.StatusUnauthorized {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
		})
	}

	listResponse := mcpAdminRequest(server, http.MethodGet, "/api/v1/settings/mcp", "", "deployment-admin")
	if listResponse.Code != http.StatusOK {
		t.Fatalf("list status=%d body=%s", listResponse.Code, listResponse.Body.String())
	}
	listed := listResponse.Body.String()
	if strings.Contains(listed, created.Secret) || strings.Contains(listed, `"secret"`) {
		t.Fatalf("list revealed credential secret: %s", listed)
	}
	for _, expected := range []string{`"enabled":false`, `"endpoint":"/mcp"`, `"status":"active"`, "HTTPS", "OAuth-only"} {
		if !strings.Contains(listed, expected) {
			t.Fatalf("list missing %q: %s", expected, listed)
		}
	}

	revokeResponse := mcpAdminRequest(server, http.MethodDelete, "/api/v1/settings/mcp/credentials/"+created.ID, "", "deployment-admin")
	if revokeResponse.Code != http.StatusOK || !strings.Contains(revokeResponse.Body.String(), `"status":"revoked"`) {
		t.Fatalf("revoke status=%d body=%s", revokeResponse.Code, revokeResponse.Body.String())
	}
	if _, err := credentials.Authenticate(t.Context(), created.Secret); !errors.Is(err, mcp.ErrCredentialUnauthorized) {
		t.Fatalf("revoked credential authentication error=%v", err)
	}
}

func TestMCPEnablementUsesPersistedRuntimeSettings(t *testing.T) {
	database, err := store.OpenDatabase(t.Context(), t.TempDir()+"/mcp-enablement.db")
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	runtimeSettings, _ := store.NewRuntimeSettingsStore(database)
	record, err := runtimeSettings.Seed(t.Context(), testRuntimeSettings())
	if err != nil {
		t.Fatal(err)
	}
	credentials, _ := mcp.NewCredentialStore(database)
	authenticator, _ := NewAuthenticator(AuthConfig{Mode: "none"})
	server, err := New(Config{
		Authenticator: authenticator, Media: &routeTestMedia{}, Preview: routeTestPreview{},
		Projects: routeTestProjects{}, BatchExports: &routeTestBatchExports{}, Jobs: &routeTestJobs{},
		Settings: runtimeSettings, RuntimeSettings: store.NewRuntimeSettingsState(record.Settings), MCPCredentials: credentials,
	})
	if err != nil {
		t.Fatal(err)
	}
	updated := record.Settings
	updated.MCPEnabled = true
	response := putSettingsRequest(t, server, record.Revision, updated)
	if response.Code != http.StatusOK {
		t.Fatalf("enable status=%d body=%s", response.Code, response.Body.String())
	}
	status := mcpAdminRequest(server, http.MethodGet, "/api/v1/settings/mcp", "", "")
	if status.Code != http.StatusOK || !strings.Contains(status.Body.String(), `"enabled":true`) {
		t.Fatalf("mcp status=%d body=%s", status.Code, status.Body.String())
	}
}

func mcpAdminRequest(server http.Handler, method, path, body, token string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	response := httptest.NewRecorder()
	server.ServeHTTP(response, request)
	return response
}
