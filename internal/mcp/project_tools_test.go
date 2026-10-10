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
	librarymedia "videocutlist/internal/library/media"
	"videocutlist/internal/mcp"
	"videocutlist/internal/preview"
	"videocutlist/internal/projects"
	"videocutlist/internal/projects/model"
)

type projectToolsCatalog struct{ toolMedia }

func (m projectToolsCatalog) Get(ctx context.Context, id string) (librarymedia.Media, error) {
	return m.toolMedia.Get(ctx, id)
}

func (m projectToolsCatalog) Browse(context.Context, string, string, int) (librarymedia.FolderPage, error) {
	return librarymedia.FolderPage{}, nil
}

func (m projectToolsCatalog) Refresh(context.Context) error { return nil }

func (m projectToolsCatalog) Preview(context.Context, preview.PreviewSpec) (preview.TranscodeSpec, error) {
	return preview.TranscodeSpec{}, nil
}

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

func (s *projectToolsService) PrepareCreate(_ context.Context, id string, input projects.ProjectInput, _ []librarymedia.Media) (projects.PreparedProject, error) {
	return projects.PreparedProject{Project: projects.Project{ID: id, Document: input.Document}}, nil
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

// changingProjectService makes the authorization read and payload read observe
// different project revisions during one tools/call request.
type changingProjectService struct {
	*projectToolsService
	reads  int
	first  projects.Project
	second projects.Project
}

func (s *changingProjectService) Get(_ context.Context, _ string) (projects.Project, error) {
	s.reads++
	if s.reads == 1 {
		return s.first, nil
	}
	return s.second, nil
}

func TestProjectToolsScopeCreationAndRevisionConflict(t *testing.T) {
	allowedMediaID := "m_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	privateMediaID := "m_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	media := toolMedia{items: []librarymedia.Media{
		{ID: allowedMediaID, RootID: "camera", Name: "allowed.mp4", DurationMS: 10_000},
		{ID: privateMediaID, RootID: "private", Name: "secret.mp4", DurationMS: 10_000},
	}}
	database, credentials, secret := projectToolsCredentials(t)
	projectStore, err := store.NewProjectStore(database)
	if err != nil {
		t.Fatal(err)
	}
	service := projects.ProjectUseCase{Repository: projects.StoreRepository{Store: projectStore}, Media: projectToolsCatalog{toolMedia: media}}
	if _, err := service.Create(t.Context(), "p_private", projects.ProjectInput{Document: model.Document{SchemaVersion: model.ProjectSchemaVersion, Name: "Private", Items: []model.ProjectItem{{ID: "i_aaaaaaaaaaaaaaaaaaaaaaaa", MediaID: privateMediaID}}}}); err != nil {
		t.Fatal(err)
	}
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
	page, err := service.List(t.Context(), "", 50)
	if err != nil || len(page.Items) != 2 {
		t.Fatalf("created project list = %#v, err=%v", page, err)
	}
	createdID := page.Items[1].ID
	if createdID == "p_private" {
		createdID = page.Items[0].ID
	}
	credential, err := credentials.Get(t.Context(), credentialID(t, credentials, secret))
	if err != nil || credential.ProjectScope.Kind != mcp.ProjectScopeSelected || !credential.AllowsProjectSummary(createdID) || credential.AllowsProjectSummary("p_ungranted") {
		t.Fatalf("created project grant = %#v, err=%v", credential.ProjectScope, err)
	}

	updated := serve(handler, sessionRequest(`{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"update_cutlist","arguments":{"projectId":"`+createdID+`","expectedRevision":1,"operations":[{"type":"add","itemId":"`+createdProjectItemID(t, service, createdID)+`","position":0,"segment":{"startMs":100,"endMs":200,"included":true}},{"type":"add","itemId":"`+createdProjectItemID(t, service, createdID)+`","position":1,"segment":{"startMs":300,"endMs":400,"included":true}}]}}}`, secret, session))
	if updated.Code != 200 || !contains(updated.Body.String(), "Cutlist updated.") {
		t.Fatalf("cutlist update = %s", updated.Body.String())
	}
	itemID := createdProjectItemID(t, service, createdID)
	project, err := service.Get(t.Context(), createdID)
	if err != nil || len(project.Items) != 1 || len(project.Items[0].Segments) != 2 {
		t.Fatalf("created cutlist = %#v, err=%v", project, err)
	}
	firstID, secondID := project.Items[0].Segments[0].ID, project.Items[0].Segments[1].ID
	if project.Items[0].Segments[0].StartMS != 100 || project.Items[0].Segments[0].EndMS != 200 || project.Items[0].Segments[1].StartMS != 300 || project.Items[0].Segments[1].EndMS != 400 {
		t.Fatalf("added segments = %#v", project.Items[0].Segments)
	}
	adjusted := serve(handler, sessionRequest(`{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"update_cutlist","arguments":{"projectId":"`+createdID+`","expectedRevision":2,"operations":[{"type":"adjust","itemId":"`+itemID+`","segmentId":"`+firstID+`","segment":{"id":"`+firstID+`","startMs":150,"endMs":250,"included":true}}]}}}`, secret, session))
	if adjusted.Code != 200 || !contains(adjusted.Body.String(), "Cutlist updated.") {
		t.Fatalf("adjust cutlist = %s", adjusted.Body.String())
	}
	project, err = service.Get(t.Context(), createdID)
	if err != nil || project.Revision != 3 || project.Items[0].Segments[0].StartMS != 150 || project.Items[0].Segments[0].EndMS != 250 {
		t.Fatalf("adjusted cutlist = %#v, err=%v", project, err)
	}
	reordered := serve(handler, sessionRequest(`{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"update_cutlist","arguments":{"projectId":"`+createdID+`","expectedRevision":3,"operations":[{"type":"reorder","itemId":"`+itemID+`","segmentIds":["`+secondID+`","`+firstID+`"]}]}}}`, secret, session))
	if reordered.Code != 200 || !contains(reordered.Body.String(), "Cutlist updated.") {
		t.Fatalf("reorder cutlist = %s", reordered.Body.String())
	}
	project, err = service.Get(t.Context(), createdID)
	if err != nil || project.Revision != 4 || project.Items[0].Segments[0].ID != secondID || project.Items[0].Segments[1].ID != firstID {
		t.Fatalf("reordered cutlist = %#v, err=%v", project, err)
	}
	removed := serve(handler, sessionRequest(`{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"update_cutlist","arguments":{"projectId":"`+createdID+`","expectedRevision":4,"operations":[{"type":"remove","itemId":"`+itemID+`","segmentId":"`+firstID+`"}]}}}`, secret, session))
	if removed.Code != 200 || !contains(removed.Body.String(), "Cutlist updated.") {
		t.Fatalf("remove cutlist = %s", removed.Body.String())
	}
	project, err = service.Get(t.Context(), createdID)
	if err != nil || project.Revision != 5 || len(project.Items[0].Segments) != 1 || project.Items[0].Segments[0].ID != secondID {
		t.Fatalf("removed cutlist = %#v, err=%v", project, err)
	}
	stale := serve(handler, sessionRequest(`{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"update_cutlist","arguments":{"projectId":"`+createdID+`","expectedRevision":1,"operations":[{"type":"remove","itemId":"`+itemID+`","segmentId":"s_missing"}]}}}`, secret, session))
	if stale.Code != 200 || !contains(stale.Body.String(), `"error":"stale_revision"`) || !contains(stale.Body.String(), "Reload the project and retry.") {
		t.Fatalf("stale update = %s", stale.Body.String())
	}
}

func TestProjectToolsInvalidArgumentsReturnInvalidInput(t *testing.T) {
	_, credentials, secret := projectToolsCredentials(t)
	service := &projectToolsService{projects: map[string]projects.Project{
		"p_existing": {ID: "p_existing", Revision: 1},
	}}
	handler := newTransport(t, mcp.TransportConfig{Enabled: true, Credentials: credentials, Tools: mcp.ProjectTools(service, toolMedia{}, credentials)})
	session := initialize(t, handler, secret)
	for _, test := range []struct {
		name, args string
	}{
		{"get_project", `{"projectId":"p_existing"}`},
		{"get_project", `{"id":null}`},
		{"create_project", `{"name":"new","mediaIds":[""]}`},
		{"create_project", `{"name":"new","mediaIds":null}`},
		{"update_cutlist", `{"projectId":"p_existing","expectedRevision":1,"operations":null}`},
		{"update_cutlist", `{"projectId":"p_existing","expectedRevision":null,"operations":[{"type":"remove","itemId":"i_valid","segmentId":"s_valid"}]}`},
		{"list_projects", `{"limit":51}`},
		{"list_projects", `{"limit":0}`},
		{"list_projects", `{"limit":null}`},
		{"list_projects", `{"cursor":null}`},
	} {
		t.Run(test.name+"/"+test.args, func(t *testing.T) {
			response := serve(handler, sessionRequest(`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"`+test.name+`","arguments":`+test.args+`}}`, secret, session))
			if response.Code != 200 || !contains(response.Body.String(), `"code":"invalid_input"`) {
				t.Fatalf("invalid arguments response = %s", response.Body.String())
			}
		})
	}
	if len(service.projects) != 1 || service.lastCreated != "" || service.projects["p_existing"].Revision != 1 {
		t.Fatalf("invalid input mutated projects: %#v", service.projects)
	}
}

func TestCutlistInvalidTargetReportsInvalidInputWithoutSaving(t *testing.T) {
	_, credentials, secret := projectToolsCredentials(t)
	mediaID := "m_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	service := &projectToolsService{projects: map[string]projects.Project{
		"p_private": {ID: "p_private", Revision: 1, Document: model.Document{Items: []model.ProjectItem{{ID: "i_existing", MediaID: mediaID}}}},
	}}
	handler := newTransport(t, mcp.TransportConfig{Enabled: true, Credentials: credentials, Tools: mcp.ProjectTools(service, toolMedia{items: []librarymedia.Media{{ID: mediaID, RootID: "camera"}}}, credentials)})
	session := initialize(t, handler, secret)
	response := serve(handler, sessionRequest(`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"update_cutlist","arguments":{"projectId":"p_private","expectedRevision":1,"operations":[{"type":"add","itemId":"i_missing","position":0,"segment":{"startMs":100,"endMs":200,"included":true}}]}}}`, secret, session))
	if response.Code != 200 || !contains(response.Body.String(), `"code":"invalid_input"`) {
		t.Fatalf("invalid cutlist target = %s", response.Body.String())
	}
	if service.projects["p_private"].Revision != 1 {
		t.Fatalf("invalid cutlist target changed revision: %#v", service.projects["p_private"])
	}
}

func TestProjectToolsAllProjectScope(t *testing.T) {
	mediaID := "m_ccccccccccccccccccccccccccccccccccccccccccc"
	media := toolMedia{items: []librarymedia.Media{{ID: mediaID, RootID: "camera", Name: "clip.mp4", DurationMS: 10_000}}}
	service := &projectToolsService{projects: map[string]projects.Project{"p_allowed": {ID: "p_allowed", Revision: 1, Document: model.Document{SchemaVersion: model.ProjectSchemaVersion, Name: "Allowed", Items: []model.ProjectItem{{ID: "i_cccccccccccccccccccccccc", MediaID: mediaID}}}}}}
	credentials, secret := projectToolsAllCredentials(t)
	handler := newTransport(t, mcp.TransportConfig{Enabled: true, Credentials: credentials, Tools: mcp.ProjectTools(service, media, credentials)})
	session := initialize(t, handler, secret)
	response := serve(handler, sessionRequest(`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_project","arguments":{"id":"p_allowed"}}}`, secret, session))
	if response.Code != 200 || !contains(response.Body.String(), "Project retrieved.") || !contains(response.Body.String(), "p_allowed") {
		t.Fatalf("all-scope project = %s", response.Body.String())
	}
}

func TestGetProjectRejectsOutOfScopeSnapshotAfterAuthorization(t *testing.T) {
	allowedMediaID := "m_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	privateMediaID := "m_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	media := toolMedia{items: []librarymedia.Media{
		{ID: allowedMediaID, RootID: "camera", Name: "allowed.mp4", DurationMS: 10_000},
		{ID: privateMediaID, RootID: "private", Name: "secret.mp4", DurationMS: 10_000},
	}}
	first := projects.Project{ID: "p_private", Revision: 1, Document: model.Document{
		SchemaVersion: model.ProjectSchemaVersion, Name: "Allowed", Items: []model.ProjectItem{
			{ID: "i_aaaaaaaaaaaaaaaaaaaaaaaa", MediaID: allowedMediaID},
		},
	}}
	second := projects.Project{ID: "p_private", Revision: 2, Document: model.Document{
		SchemaVersion: model.ProjectSchemaVersion, Name: "Changed", Items: []model.ProjectItem{
			{ID: "i_aaaaaaaaaaaaaaaaaaaaaaaa", MediaID: allowedMediaID},
			{ID: "i_bbbbbbbbbbbbbbbbbbbbbbbb", MediaID: privateMediaID, Segments: []model.Segment{
				{StartMS: 1000, EndMS: 2000, Label: "secret-cutlist-marker", Included: true},
			}},
		},
	}}
	service := &changingProjectService{projectToolsService: &projectToolsService{}, first: first, second: second}
	_, credentials, secret := projectToolsCredentials(t)
	handler := newTransport(t, mcp.TransportConfig{Enabled: true, Credentials: credentials, Tools: mcp.ProjectTools(service, media, credentials)})
	session := initialize(t, handler, secret)

	response := serve(handler, sessionRequest(`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_project","arguments":{"id":"p_private"}}}`, secret, session))
	body := response.Body.String()
	if service.reads != 2 {
		t.Fatalf("project reads = %d, want authorization and changed payload reads", service.reads)
	}
	if response.Code != 200 || !contains(body, `"code":"access_denied"`) || contains(body, "secret-cutlist-marker") || contains(body, privateMediaID) || contains(body, `"revision":2`) {
		t.Fatalf("changed project response = %s", body)
	}
}

func createdProjectItemID(t *testing.T, service projects.ProjectService, id string) string {
	t.Helper()
	project, err := service.Get(t.Context(), id)
	if err != nil || len(project.Items) != 1 {
		t.Fatalf("created project = %#v, %v", project, err)
	}
	return project.Items[0].ID
}

func projectToolsCredentials(t *testing.T) (*sql.DB, *mcp.CredentialStore, string) {
	t.Helper()
	database, err := store.OpenDatabase(t.Context(), t.TempDir()+"/mcp-projects.db")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	credentials, err := mcp.NewCredentialStore(newMCPRepository(t, database))
	if err != nil {
		t.Fatal(err)
	}
	expires := time.Now().Add(time.Hour)
	created, err := credentials.Create(t.Context(), mcp.CredentialInput{Name: "project tools", Permissions: []mcp.Permission{mcp.PermissionMediaRead, mcp.PermissionProjectsRead, mcp.PermissionProjectsWrite}, MediaScope: mcp.MediaScope{Kind: mcp.MediaScopeRoots, RootIDs: []string{"camera"}}, ProjectScope: mcp.ProjectScope{Kind: mcp.ProjectScopeSelected, ProjectIDs: []string{"p_private"}}, ExpiresAt: &expires})
	if err != nil {
		t.Fatal(err)
	}
	return database, credentials, created.Secret
}

func projectToolsAllCredentials(t *testing.T) (*mcp.CredentialStore, string) {
	t.Helper()
	database, err := store.OpenDatabase(t.Context(), t.TempDir()+"/mcp-projects-all.db")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	credentials, err := mcp.NewCredentialStore(newMCPRepository(t, database))
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
