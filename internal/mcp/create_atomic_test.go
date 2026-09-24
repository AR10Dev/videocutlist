package mcp_test

import (
	"context"
	"database/sql"
	"fmt"
	"testing"
	"time"
	store "videocutlist/internal/db"
	"videocutlist/internal/mcp"
	"videocutlist/internal/projects"
	appRuntime "videocutlist/internal/runtime"
)

type atomicProjectMedia struct {
	projects.MediaCatalog
	media projects.Media
}

func (m atomicProjectMedia) Get(context.Context, string) (projects.Media, error) { return m.media, nil }

type databaseProjectMedia struct {
	projects.MediaCatalog
	db    *sql.DB
	media projects.Media
}

func (m databaseProjectMedia) Get(ctx context.Context, _ string) (projects.Media, error) {
	var value int
	if err := m.db.QueryRowContext(ctx, "SELECT 1").Scan(&value); err != nil {
		return projects.Media{}, err
	}
	return m.media, nil
}

func TestCreateProjectAndGrantRollBackTogetherAtCapacity(t *testing.T) {
	database, credentials, clock := newCredentialStore(t)
	ids := make([]string, 1000)
	for i := range ids {
		ids[i] = fmt.Sprintf("p_atomic%04d", i)
	}
	expires := clock.Add(time.Hour)
	created, err := credentials.Create(t.Context(), mcp.CredentialInput{Name: "atomic", Permissions: []mcp.Permission{mcp.PermissionProjectsRead, mcp.PermissionProjectsWrite, mcp.PermissionMediaRead}, MediaScope: mcp.MediaScope{Kind: mcp.MediaScopeAll}, ProjectScope: mcp.ProjectScope{Kind: mcp.ProjectScopeSelected, ProjectIDs: ids}, ExpiresAt: &expires})
	if err != nil {
		t.Fatal(err)
	}
	projectStore, err := store.NewProjectStore(database)
	if err != nil {
		t.Fatal(err)
	}
	media := projects.Media{ID: "m_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", RootID: "camera", DurationMS: 1000}
	service := projects.ProjectUseCase{Repository: appRuntime.ProjectRepository{Store: projectStore}, Media: atomicProjectMedia{media: media}}
	handler := newTransport(t, mcp.TransportConfig{Enabled: true, Credentials: credentials, Tools: mcp.ProjectTools(service, toolMedia{items: []projects.Media{media}}, credentials)})
	session := initialize(t, handler, created.Secret)
	response := serve(handler, sessionRequest(`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"create_project","arguments":{"name":"Atomic","mediaIds":["m_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]}}}`, created.Secret, session))
	if !contains(response.Body.String(), "Tool failed.") {
		t.Fatalf("capacity create succeeded: %s", response.Body.String())
	}
	page, err := service.List(t.Context(), "", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 0 {
		t.Fatalf("orphan project after rejected grant: %#v", page.Items)
	}
	if _, err = credentials.Authenticate(t.Context(), created.Secret); err != nil {
		t.Fatalf("credential unreadable: %v", err)
	}
}

func TestCreateProjectGrantUsesSingleDatabaseConnection(t *testing.T) {
	database, credentials, clock := newCredentialStore(t)
	expires := clock.Add(time.Hour)
	created, err := credentials.Create(t.Context(), mcp.CredentialInput{Name: "creator", Permissions: []mcp.Permission{mcp.PermissionProjectsRead, mcp.PermissionProjectsWrite, mcp.PermissionMediaRead}, MediaScope: mcp.MediaScope{Kind: mcp.MediaScopeAll}, ProjectScope: mcp.ProjectScope{Kind: mcp.ProjectScopeSelected, ProjectIDs: []string{"p_existing"}}, ExpiresAt: &expires})
	if err != nil {
		t.Fatal(err)
	}
	projectStore, err := store.NewProjectStore(database)
	if err != nil {
		t.Fatal(err)
	}
	media := projects.Media{ID: "m_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", RootID: "camera", DurationMS: 1000}
	service := projects.ProjectUseCase{Repository: appRuntime.ProjectRepository{Store: projectStore}, Media: databaseProjectMedia{db: database, media: media}}
	handler := newTransport(t, mcp.TransportConfig{Enabled: true, Credentials: credentials, Tools: mcp.ProjectTools(service, toolMedia{items: []projects.Media{media}}, credentials)})
	session := initialize(t, handler, created.Secret)
	ctx, cancel := context.WithTimeout(t.Context(), time.Second)
	defer cancel()
	request := sessionRequest(`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"create_project","arguments":{"name":"Single connection","mediaIds":["m_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]}}}`, created.Secret, session)
	response := serve(handler, request.WithContext(ctx))
	if !contains(response.Body.String(), "Project created.") {
		t.Fatalf("project creation failed with one database connection: %s", response.Body.String())
	}
}
