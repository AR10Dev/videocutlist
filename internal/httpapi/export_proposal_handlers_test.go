package httpapi

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	store "videocutlist/internal/db"
	jobqueue "videocutlist/internal/jobs"
	"videocutlist/internal/mcp"
	"videocutlist/internal/projects"
	"videocutlist/internal/projects/model"
)

type proposalHTTPProjects struct{ project projects.Project }

func (p proposalHTTPProjects) Create(context.Context, string, projects.ProjectInput) (projects.Project, error) {
	return projects.Project{}, nil
}
func (p proposalHTTPProjects) Get(context.Context, string) (projects.Project, error) { return p.project, nil }
func (p proposalHTTPProjects) Save(context.Context, string, projects.ProjectInput) (projects.Project, error) {
	return projects.Project{}, nil
}

type proposalHTTPMedia struct{ media projects.Media }

func (m proposalHTTPMedia) Get(context.Context, string) (projects.Media, error) { return m.media, nil }
func (m proposalHTTPMedia) List(context.Context, string, int) (projects.MediaPage, error) {
	return projects.MediaPage{}, nil
}
func (m proposalHTTPMedia) Browse(context.Context, string, string, int) (projects.FolderPage, error) {
	return projects.FolderPage{}, nil
}
func (m proposalHTTPMedia) Refresh(context.Context) error { return nil }
func (m proposalHTTPMedia) Preview(context.Context, projects.PreviewSpec) (model.PreviewSpec, error) {
	return model.PreviewSpec{}, nil
}

type proposalHTTPPreflight struct{}

func (proposalHTTPPreflight) Preflight(context.Context, string, projects.Project, projects.ExportInput) (projects.ExportPreflight, error) {
	return projects.ExportPreflight{Allowed: true, Selection: []int{0}}, nil
}

func TestExportProposalHTTPApprovalAndSettingsListDetails(t *testing.T) {
	database, err := store.OpenDatabase(t.Context(), t.TempDir()+"/proposal-http.db")
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
	expires := time.Now().UTC().Add(time.Hour)
	created, err := credentials.Create(t.Context(), mcp.CredentialInput{Name: "assistant", Permissions: []mcp.Permission{mcp.PermissionExportsPrepare, mcp.PermissionExportsRun}, MediaScope: mcp.MediaScope{Kind: mcp.MediaScopeAll}, ProjectScope: mcp.ProjectScope{Kind: mcp.ProjectScopeAll}, ExpiresAt: &expires})
	if err != nil {
		t.Fatal(err)
	}
	projectID, mediaID := "p_proposalhttp1", "m_proposalhttp1"
	if _, err := database.ExecContext(t.Context(), `INSERT INTO projects (id,revision,document_json,created_at,updated_at) VALUES (?,1,'{}',?,?)`, projectID, time.Now().UTC().Format(time.RFC3339Nano), time.Now().UTC().Format(time.RFC3339Nano)); err != nil {
		t.Fatal(err)
	}
	jobs, _ := jobqueue.NewJobsStore(database)
	scheduler, _ := jobqueue.NewScheduler(jobs, jobqueue.SchedulerConfig{QueueCapacity: 4, WorkerLimit: 1}, func(context.Context, jobqueue.Job) error { return nil })
	service, err := mcp.NewProposalService(database, credentials, proposalHTTPProjects{project: projects.Project{ID: projectID, Revision: 1, Document: model.Document{SchemaVersion: model.ProjectSchemaVersion, Name: "Proposal", Items: []model.ProjectItem{{ID: "i_proposalhttp1", MediaID: mediaID, Segments: []model.Segment{{StartMS: 100, EndMS: 200}}}}}}}, proposalHTTPMedia{media: projects.Media{ID: mediaID, RootID: "root_a", Name: "clip.mp4", DurationMS: 1000, SizeBytes: 10, ETag: "v1"}}, proposalHTTPPreflight{}, scheduler)
	if err != nil {
		t.Fatal(err)
	}
	proposal, err := service.Prepare(t.Context(), mcp.ProposalRequest{CredentialID: created.ID, ProjectID: projectID, ProjectRevision: 1, Export: projects.ExportInput{Mode: "merge", Selection: "segments", CutStrategy: "stream_copy_preferred", Container: "mp4", DestinationID: "download"}})
	if err != nil {
		t.Fatal(err)
	}
	authenticator, _ := NewAuthenticator(AuthConfig{Mode: "none"})
	server, err := New(Config{Authenticator: authenticator, Media: &routeTestMedia{}, Preview: routeTestPreview{}, Projects: routeTestProjects{}, BatchExports: &routeTestBatchExports{}, Jobs: &routeTestJobs{}, Settings: runtimeSettings, RuntimeSettings: store.NewRuntimeSettingsState(record.Settings), MCPCredentials: credentials, ExportProposals: service})
	if err != nil {
		t.Fatal(err)
	}
	settings := mcpAdminRequest(server, http.MethodGet, "/api/v1/settings/mcp", "", "")
	if settings.Code != http.StatusOK || !strings.Contains(settings.Body.String(), proposal.ID) || !strings.Contains(settings.Body.String(), "clip.mp4") {
		t.Fatalf("settings status=%d body=%s", settings.Code, settings.Body.String())
	}
	approved := mcpAdminRequest(server, http.MethodPost, "/api/v1/export-proposals/"+proposal.ID+"/approval", "", "")
	if approved.Code != http.StatusOK || !strings.Contains(approved.Body.String(), `"approvedAt"`) {
		t.Fatalf("approval status=%d body=%s", approved.Code, approved.Body.String())
	}
}
