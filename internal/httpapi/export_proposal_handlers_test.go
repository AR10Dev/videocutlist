package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"
	store "videocutlist/internal/db"
	exporter "videocutlist/internal/export"
	jobservice "videocutlist/internal/jobs"
	jobqueue "videocutlist/internal/jobs/model"
	librarymedia "videocutlist/internal/library/media"
	"videocutlist/internal/mcp"
	"videocutlist/internal/preview"
	"videocutlist/internal/projects"
	"videocutlist/internal/projects/model"
	settingsdomain "videocutlist/internal/settings"
	settingsmodel "videocutlist/internal/settings/model"
	testsupport "videocutlist/internal/testsupport"
)

type proposalHTTPProjects struct{ project projects.Project }

func (p proposalHTTPProjects) Create(context.Context, string, projects.ProjectInput) (projects.Project, error) {
	return projects.Project{}, nil
}
func (p proposalHTTPProjects) Get(context.Context, string) (projects.Project, error) {
	return p.project, nil
}
func (p proposalHTTPProjects) Save(context.Context, string, projects.ProjectInput) (projects.Project, error) {
	return projects.Project{}, nil
}

type proposalHTTPMedia struct{ media librarymedia.Media }

func (m proposalHTTPMedia) Get(context.Context, string) (librarymedia.Media, error) {
	return m.media, nil
}
func (m proposalHTTPMedia) List(context.Context, string, int) (librarymedia.MediaPage, error) {
	return librarymedia.MediaPage{}, nil
}
func (m proposalHTTPMedia) Browse(context.Context, string, string, int) (librarymedia.FolderPage, error) {
	return librarymedia.FolderPage{}, nil
}
func (m proposalHTTPMedia) Refresh(context.Context) error { return nil }
func (m proposalHTTPMedia) Preview(context.Context, preview.PreviewSpec) (preview.TranscodeSpec, error) {
	return preview.TranscodeSpec{}, nil
}

type proposalHTTPPreflight struct{}

func (proposalHTTPPreflight) Preflight(context.Context, projects.Project, projects.ExportInput) (exporter.PreflightResult, error) {
	return exporter.PreflightResult{Allowed: true, Selection: []int{0}}, nil
}

func TestExportProposalHTTPApprovalAndSettingsListDetails(t *testing.T) {
	database, err := store.OpenDatabase(t.Context(), t.TempDir()+"/proposal-http.db")
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := database.Close(); err != nil {
			t.Error(err)
		}
	}()
	runtimeSettings, _ := store.NewRuntimeSettingsStore(database)
	record, err := runtimeSettings.Seed(t.Context(), testRuntimeSettings())
	if err != nil {
		t.Fatal(err)
	}
	mcpStorage := newMCPTestStorage(t, database)
	credentials, _ := mcp.NewCredentialStore(mcpStorage)
	expires := time.Now().UTC().Add(time.Hour)
	created, err := credentials.Create(t.Context(), mcp.CredentialInput{Name: "assistant", Permissions: []mcp.Permission{mcp.PermissionExportsPrepare, mcp.PermissionExportsRun}, MediaScope: mcp.MediaScope{Kind: mcp.MediaScopeAll}, ProjectScope: mcp.ProjectScope{Kind: mcp.ProjectScopeAll}, ExpiresAt: &expires})
	if err != nil {
		t.Fatal(err)
	}
	projectID, mediaID := "p_proposalhttp1", "m_proposalhttp1"
	if _, err := database.ExecContext(t.Context(), `INSERT INTO projects (id,revision,document_json,created_at,updated_at) VALUES (?,1,'{}',?,?)`, projectID, time.Now().UTC().Format(time.RFC3339Nano), time.Now().UTC().Format(time.RFC3339Nano)); err != nil {
		t.Fatal(err)
	}
	jobs, _ := testsupport.NewJobsStore(database)
	scheduler, _ := jobservice.NewScheduler(jobs, jobservice.SchedulerConfig{QueueCapacity: 4, WorkerLimit: 1}, func(context.Context, jobqueue.Job) error { return nil })
	service, err := mcp.NewProposalService(mcpStorage, credentials, proposalHTTPProjects{project: projects.Project{ID: projectID, Revision: 1, Document: model.Document{SchemaVersion: model.ProjectSchemaVersion, Name: "Proposal", Items: []model.ProjectItem{{ID: "i_proposalhttp1", MediaID: mediaID, Segments: []model.Segment{{StartMS: 100, EndMS: 200}}}}}}}, proposalHTTPMedia{media: librarymedia.Media{ID: mediaID, RootID: "root_a", Name: "clip.mp4", DurationMS: 1000, SizeBytes: 10, ETag: "v1"}}, proposalHTTPPreflight{}, scheduler)
	if err != nil {
		t.Fatal(err)
	}
	proposalRequest := mcp.ProposalRequest{CredentialID: created.ID, ProjectID: projectID, ProjectRevision: 1, Export: projects.ExportInput{Mode: "merge", Selection: "segments", CutStrategy: "stream_copy_preferred", Container: "mp4", DestinationID: "download"}}
	proposal, err := service.Prepare(t.Context(), proposalRequest)
	if err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if _, err := service.Prepare(t.Context(), proposalRequest); err != nil {
			t.Fatal(err)
		}
	}
	authenticator, _ := NewAuthenticator(AuthConfig{Mode: "none"})
	server, err := New(Config{Authenticator: authenticator, Media: &routeTestMedia{}, Preview: routeTestPreview{}, Projects: routeTestProjects{}, BatchExports: &routeTestBatchExports{}, Jobs: &routeTestJobs{}, Settings: settingsdomain.NewRuntimeService(runtimeSettings, nil, nil), RuntimeSettings: settingsmodel.NewRuntimeSettingsState(record.Settings), MCPCredentials: credentials, ExportProposals: service})
	if err != nil {
		t.Fatal(err)
	}
	settings := mcpAdminRequest(server, http.MethodGet, "/api/v2/settings/mcp", "", "")
	if settings.Code != http.StatusOK || !strings.Contains(settings.Body.String(), proposal.ID) || !strings.Contains(settings.Body.String(), "clip.mp4") {
		t.Fatalf("settings status=%d body=%s", settings.Code, settings.Body.String())
	}
	firstPage := mcpAdminRequest(server, http.MethodGet, "/api/v2/settings/mcp?proposalLimit=2", "", "")
	var page struct {
		Proposals          []mcp.ExportProposal `json:"proposals"`
		ProposalNextCursor string               `json:"proposalNextCursor"`
	}
	if err := json.Unmarshal(firstPage.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	if firstPage.Code != http.StatusOK || len(page.Proposals) != 2 || page.ProposalNextCursor == "" {
		t.Fatalf("first proposal page=%s", firstPage.Body.String())
	}
	secondPage := mcpAdminRequest(server, http.MethodGet, "/api/v2/settings/mcp?proposalLimit=2&proposalCursor="+page.ProposalNextCursor, "", "")
	var rest struct {
		Proposals          []mcp.ExportProposal `json:"proposals"`
		ProposalNextCursor string               `json:"proposalNextCursor"`
	}
	if err := json.Unmarshal(secondPage.Body.Bytes(), &rest); err != nil {
		t.Fatal(err)
	}
	if secondPage.Code != http.StatusOK || len(rest.Proposals) != 1 || rest.ProposalNextCursor != "" || rest.Proposals[0].ID == page.Proposals[0].ID {
		t.Fatalf("second proposal page=%s", secondPage.Body.String())
	}
	invalidCursor := mcpAdminRequest(server, http.MethodGet, "/api/v2/settings/mcp?proposalCursor=invalid", "", "")
	if invalidCursor.Code != http.StatusBadRequest || !strings.Contains(invalidCursor.Body.String(), `"code":"invalid_query"`) {
		t.Fatalf("invalid proposal cursor status=%d body=%s", invalidCursor.Code, invalidCursor.Body.String())
	}
	approved := mcpAdminRequest(server, http.MethodPost, "/api/v2/export-proposals/"+proposal.ID+"/approval", "", "")
	if approved.Code != http.StatusOK || !strings.Contains(approved.Body.String(), `"approvedAt"`) {
		t.Fatalf("approval status=%d body=%s", approved.Code, approved.Body.String())
	}
}
