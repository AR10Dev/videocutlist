package mcp_test

import (
	"cmp"
	"context"
	"database/sql"
	"slices"
	"sync"
	"testing"
	"time"

	store "videocutlist/internal/db"
	"videocutlist/internal/mcp"
	"videocutlist/internal/projects"
	"videocutlist/internal/projects/model"
)

type projectToolsService struct {
	mu          sync.Mutex
	projects    map[string]projects.Project
	lastCreated string
}

func (s *projectToolsService) Create(_ context.Context, id string, input projects.ProjectInput) (projects.Project, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, exists := s.projects[id]; exists {
		return projects.Project{}, store.ErrRevisionConflict
	}
	project := projects.Project{ID: id, Revision: 1, Document: input.Document, UpdatedAt: time.Now().UTC()}
	s.projects[id] = project
	s.lastCreated = id
	return project, nil
}

func (s *projectToolsService) CreateInTx(ctx context.Context, _ *sql.Tx, id string, input projects.ProjectInput, _ []projects.Media) (projects.Project, error) {
	return s.Create(ctx, id, input)
}

func (s *projectToolsService) Get(_ context.Context, id string) (projects.Project, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	project, ok := s.projects[id]
	if !ok {
		return projects.Project{}, store.ErrProjectNotFound
	}
	return project, nil
}

func (s *projectToolsService) Save(_ context.Context, id string, input projects.ProjectInput) (projects.Project, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	project, ok := s.projects[id]
	if !ok {
		return projects.Project{}, store.ErrProjectNotFound
	}
	if project.Revision != input.Revision {
		return projects.Project{}, store.ErrRevisionConflict
	}
	project.Document = input.Document
	project.Revision++
	project.UpdatedAt = time.Now().UTC()
	s.projects[id] = project
	return project, nil
}

func (s *projectToolsService) List(_ context.Context, cursor string, limit int) (projects.ProjectPage, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	items := make([]projects.ProjectSummary, 0, len(s.projects))
	for _, project := range s.projects {
		if project.ID > cursor {
			items = append(items, projects.ProjectSummary{ID: project.ID, Name: project.Name, Revision: project.Revision, UpdatedAt: project.UpdatedAt})
		}
	}
	slices.SortFunc(items, func(a, b projects.ProjectSummary) int { return cmp.Compare(a.ID, b.ID) })
	page := projects.ProjectPage{Items: items}
	if len(page.Items) > limit {
		next := page.Items[limit-1].ID
		page.NextCursor = &next
		page.Items = page.Items[:limit]
	}
	return page, nil
}

func TestProjectToolsScopeCreationAndRevisionConflict(t *testing.T) {
	allowedMediaID := "m_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	privateMediaID := "m_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	media := toolMedia{items: []projects.Media{
		{ID: allowedMediaID, RootID: "camera", Name: "allowed.mp4", DurationMS: 10_000},
		{ID: privateMediaID, RootID: "private", Name: "secret.mp4", DurationMS: 10_000},
	}}
	service := &projectToolsService{projects: map[string]projects.Project{
		"p_private": {ID: "p_private", Revision: 1, Document: model.Document{SchemaVersion: model.ProjectSchemaVersion, Name: "Private", Items: []model.ProjectItem{{ID: "i_aaaaaaaaaaaaaaaaaaaaaaaa", MediaID: privateMediaID}}}},
	}}
	credentials, secret := projectToolsCredentials(t)
	handler := newTransport(t, mcp.TransportConfig{Enabled: true, Credentials: credentials, Tools: append(mcp.MediaTools(media), mcp.ProjectTools(service, media, credentials)...)})
	session := initialize(t, handler, secret)

	list := serve(handler, sessionRequest(`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_projects","arguments":{}}}`, secret, session))
	if list.Code != 200 || !contains(list.Body.String(), "p_private") {
		t.Fatalf("project list = %s", list.Body.String())
	}
	private := serve(handler, sessionRequest(`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_project","arguments":{"id":"p_private"}}}`, secret, session))
	if !contains(private.Body.String(), "Tool failed.") || contains(private.Body.String(), "secret.mp4") || contains(private.Body.String(), "private") {
		t.Fatalf("out-of-scope project = %s", private.Body.String())
	}

	created := serve(handler, sessionRequest(`{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"create_project","arguments":{"name":"New project","mediaIds":["m_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]}}}`, secret, session))
	if created.Code != 200 || !contains(created.Body.String(), "Project created.") {
		t.Fatalf("created project = %s", created.Body.String())
	}
	service.mu.Lock()
	createdID := service.lastCreated
	service.mu.Unlock()
	credential, err := credentials.Get(t.Context(), credentialID(t, credentials, secret))
	if err != nil || credential.ProjectScope.Kind != mcp.ProjectScopeSelected || !credential.AllowsProjectSummary(createdID) || credential.AllowsProjectSummary("p_ungranted") {
		t.Fatalf("created project grant = %#v, err=%v", credential.ProjectScope, err)
	}

	updated := serve(handler, sessionRequest(`{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"update_cutlist","arguments":{"projectId":"`+createdID+`","expectedRevision":1,"operations":[{"type":"add","itemId":"`+createdProjectItemID(t, service, createdID)+`","position":0,"segment":{"startMs":100,"endMs":200,"included":true}}]}}}`, secret, session))
	if updated.Code != 200 || !contains(updated.Body.String(), "Cutlist updated.") {
		t.Fatalf("cutlist update = %s", updated.Body.String())
	}
	itemID, segmentID := createdProjectSegment(t, service, createdID)
	for _, request := range []string{
		`{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"update_cutlist","arguments":{"projectId":"` + createdID + `","expectedRevision":2,"operations":[{"type":"adjust","itemId":"` + itemID + `","segmentId":"` + segmentID + `","segment":{"id":"` + segmentID + `","startMs":150,"endMs":250,"included":true}}]}}}`,
		`{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"update_cutlist","arguments":{"projectId":"` + createdID + `","expectedRevision":3,"operations":[{"type":"reorder","itemId":"` + itemID + `","segmentIds":["` + segmentID + `"]}]}}}`,
		`{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"update_cutlist","arguments":{"projectId":"` + createdID + `","expectedRevision":4,"operations":[{"type":"remove","itemId":"` + itemID + `","segmentId":"` + segmentID + `"}]}}}`,
	} {
		response := serve(handler, sessionRequest(request, secret, session))
		if response.Code != 200 || !contains(response.Body.String(), "Cutlist updated.") {
			t.Fatalf("cutlist operation = %s", response.Body.String())
		}
	}
	stale := serve(handler, sessionRequest(`{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"update_cutlist","arguments":{"projectId":"`+createdID+`","expectedRevision":1,"operations":[{"type":"remove","itemId":"`+itemID+`","segmentId":"s_missing"}]}}}`, secret, session))
	if stale.Code != 200 || !contains(stale.Body.String(), `"error":"stale_revision"`) || !contains(stale.Body.String(), "Reload the project and retry.") {
		t.Fatalf("stale update = %s", stale.Body.String())
	}
}

func TestProjectToolsAllProjectScope(t *testing.T) {
	mediaID := "m_ccccccccccccccccccccccccccccccccccccccccccc"
	media := toolMedia{items: []projects.Media{{ID: mediaID, RootID: "camera", Name: "clip.mp4", DurationMS: 10_000}}}
	service := &projectToolsService{projects: map[string]projects.Project{"p_allowed": {ID: "p_allowed", Revision: 1, Document: model.Document{SchemaVersion: model.ProjectSchemaVersion, Name: "Allowed", Items: []model.ProjectItem{{ID: "i_cccccccccccccccccccccccc", MediaID: mediaID}}}}}}
	credentials, secret := projectToolsAllCredentials(t)
	handler := newTransport(t, mcp.TransportConfig{Enabled: true, Credentials: credentials, Tools: mcp.ProjectTools(service, media, credentials)})
	session := initialize(t, handler, secret)
	response := serve(handler, sessionRequest(`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_project","arguments":{"id":"p_allowed"}}}`, secret, session))
	if response.Code != 200 || !contains(response.Body.String(), "Project retrieved.") || !contains(response.Body.String(), "p_allowed") {
		t.Fatalf("all-scope project = %s", response.Body.String())
	}
}

func createdProjectItemID(t *testing.T, service *projectToolsService, id string) string {
	t.Helper()
	project, err := service.Get(t.Context(), id)
	if err != nil || len(project.Items) != 1 {
		t.Fatalf("created project = %#v, %v", project, err)
	}
	return project.Items[0].ID
}

func createdProjectSegment(t *testing.T, service *projectToolsService, id string) (string, string) {
	t.Helper()
	project, err := service.Get(t.Context(), id)
	if err != nil || len(project.Items) != 1 || len(project.Items[0].Segments) != 1 {
		t.Fatalf("created project segment = %#v, %v", project, err)
	}
	return project.Items[0].ID, project.Items[0].Segments[0].ID
}

func projectToolsCredentials(t *testing.T) (*mcp.CredentialStore, string) {
	t.Helper()
	database, err := store.OpenDatabase(t.Context(), t.TempDir()+"/mcp-projects.db")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	credentials, err := mcp.NewCredentialStore(database)
	if err != nil {
		t.Fatal(err)
	}
	expires := time.Now().Add(time.Hour)
	created, err := credentials.Create(t.Context(), mcp.CredentialInput{Name: "project tools", Permissions: []mcp.Permission{mcp.PermissionMediaRead, mcp.PermissionProjectsRead, mcp.PermissionProjectsWrite}, MediaScope: mcp.MediaScope{Kind: mcp.MediaScopeRoots, RootIDs: []string{"camera"}}, ProjectScope: mcp.ProjectScope{Kind: mcp.ProjectScopeSelected, ProjectIDs: []string{"p_private"}}, ExpiresAt: &expires})
	if err != nil {
		t.Fatal(err)
	}
	return credentials, created.Secret
}

func projectToolsAllCredentials(t *testing.T) (*mcp.CredentialStore, string) {
	t.Helper()
	database, err := store.OpenDatabase(t.Context(), t.TempDir()+"/mcp-projects-all.db")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	credentials, err := mcp.NewCredentialStore(database)
	if err != nil {
		t.Fatal(err)
	}
	expires := time.Now().Add(time.Hour)
	created, err := credentials.Create(t.Context(), mcp.CredentialInput{Name: "all projects", Permissions: []mcp.Permission{mcp.PermissionMediaRead, mcp.PermissionProjectsRead}, MediaScope: mcp.MediaScope{Kind: mcp.MediaScopeAll}, ProjectScope: mcp.ProjectScope{Kind: mcp.ProjectScopeAll}, ExpiresAt: &expires})
	if err != nil {
		t.Fatal(err)
	}
	return credentials, created.Secret
}

func credentialID(t *testing.T, credentials *mcp.CredentialStore, secret string) string {
	t.Helper()
	credential, err := credentials.Authenticate(t.Context(), secret)
	if err != nil {
		t.Fatal(err)
	}
	return credential.ID
}
