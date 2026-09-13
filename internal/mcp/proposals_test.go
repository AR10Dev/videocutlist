package mcp

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"videocutlist/internal/db"
	jobqueue "videocutlist/internal/jobs"
	"videocutlist/internal/projects"
	"videocutlist/internal/projects/model"
)

type proposalProjects struct{ project projects.Project }

func (p *proposalProjects) Create(context.Context, string, projects.ProjectInput) (projects.Project, error) {
	return projects.Project{}, errors.New("not used")
}
func (p *proposalProjects) Get(context.Context, string) (projects.Project, error) {
	return p.project, nil
}
func (p *proposalProjects) Save(context.Context, string, projects.ProjectInput) (projects.Project, error) {
	return projects.Project{}, errors.New("not used")
}

type proposalMedia struct{ item projects.Media }

func (m *proposalMedia) Get(context.Context, string) (projects.Media, error) { return m.item, nil }
func (m *proposalMedia) List(context.Context, string, int) (projects.MediaPage, error) {
	return projects.MediaPage{}, nil
}
func (m *proposalMedia) Browse(context.Context, string, string, int) (projects.FolderPage, error) {
	return projects.FolderPage{}, nil
}
func (m *proposalMedia) Refresh(context.Context) error { return nil }
func (m *proposalMedia) Preview(context.Context, projects.PreviewSpec) (model.PreviewSpec, error) {
	return model.PreviewSpec{}, nil
}

type proposalPreflight struct{}

func (proposalPreflight) Preflight(_ context.Context, _ string, _ projects.Project, input projects.ExportInput) (projects.ExportPreflight, error) {
	selection := input.StreamIndexes
	if len(selection) == 0 {
		selection = []int{0, 1}
	}
	return projects.ExportPreflight{Allowed: true, Selection: selection, Findings: []projects.ExportFinding{{Severity: "warn", Code: "stream_copy_cut_may_not_be_frame_exact", Message: "Stream-copy boundaries are keyframe-limited."}}}, nil
}

func newProposalTestService(t *testing.T, unattended bool) (*ProposalService, *proposalProjects, *proposalMedia, string, *time.Time) {
	t.Helper()
	ctx := t.Context()
	database, err := store.OpenDatabase(ctx, t.TempDir()+"/proposals.db")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	now := time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC)
	credentials, err := NewCredentialStoreWithClock(database, func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	expires := now.Add(time.Hour)
	created, err := credentials.Create(ctx, CredentialInput{
		Name: "proposal test", Permissions: []Permission{PermissionExportsPrepare, PermissionExportsRun},
		MediaScope: MediaScope{Kind: MediaScopeAll}, ProjectScope: ProjectScope{Kind: ProjectScopeAll}, ExpiresAt: &expires,
		UnattendedExports: unattended,
	})
	if err != nil {
		t.Fatal(err)
	}
	projectID := "p_proposaltest01"
	itemID := "i_proposaltest01"
	mediaID := "m_proposaltest01"
	if _, err := database.ExecContext(ctx, `INSERT INTO projects (id,revision,document_json,created_at,updated_at) VALUES (?,1,'{}',?,?)`, projectID, now.Format(time.RFC3339Nano), now.Format(time.RFC3339Nano)); err != nil {
		t.Fatal(err)
	}
	projectService := &proposalProjects{project: projects.Project{ID: projectID, Revision: 1, Document: model.Document{SchemaVersion: model.ProjectSchemaVersion, Name: "Proposal", Items: []model.ProjectItem{{ID: itemID, MediaID: mediaID, Segments: []model.Segment{{StartMS: 1000, EndMS: 2000}}}}}}}
	mediaService := &proposalMedia{item: projects.Media{ID: mediaID, RootID: "root_a", Name: "clip.mp4", DurationMS: 10_000, SizeBytes: 100, ETag: "source-v1"}}
	jobs, err := jobqueue.NewJobsStore(database)
	if err != nil {
		t.Fatal(err)
	}
	scheduler, err := jobqueue.NewScheduler(jobs, jobqueue.SchedulerConfig{QueueCapacity: 4, WorkerLimit: 1}, func(context.Context, jobqueue.Job) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	service, err := NewProposalService(database, credentials, projectService, mediaService, proposalPreflight{}, scheduler)
	if err != nil {
		t.Fatal(err)
	}
	service.now = func() time.Time { return now }
	return service, projectService, mediaService, created.ID, &now
}

func prepareProposal(t *testing.T, service *ProposalService, credentialID string) ExportProposal {
	t.Helper()
	proposal, err := service.Prepare(t.Context(), ProposalRequest{
		CredentialID: credentialID, ProjectID: "p_proposaltest01", ProjectRevision: 1,
		Export: projects.ExportInput{Mode: "merge", Selection: "segments", CutStrategy: "stream_copy_preferred", Container: "mp4", DestinationID: "download"},
	})
	if err != nil {
		t.Fatal(err)
	}
	return proposal
}

func TestProposalRequiresExactApprovalAndDuplicateExecutionReturnsSameBatch(t *testing.T) {
	service, _, _, credentialID, _ := newProposalTestService(t, false)
	proposal := prepareProposal(t, service, credentialID)
	if proposal.ExpiresAt.Sub(proposal.CreatedAt) != ProposalTTL || proposal.Accuracy != "keyframe_limited" || proposal.RequiresReencoding || len(proposal.Findings) == 0 || len(proposal.Snapshots) != 1 || proposal.Snapshots[0].Source.ETag != "source-v1" {
		t.Fatalf("proposal did not bind validated inputs: %#v", proposal)
	}
	if _, _, err := service.Execute(t.Context(), proposal.ID, credentialID); !errors.Is(err, ErrProposalApprovalNeeded) {
		t.Fatalf("unapproved execution error = %v", err)
	}
	if _, err := service.Approve(t.Context(), proposal.ID); err != nil {
		t.Fatal(err)
	}
	var batches [2]string
	var counts [2]int
	var wg sync.WaitGroup
	for index := range 2 {
		wg.Go(func() {
			batch, jobs, err := service.Execute(t.Context(), proposal.ID, credentialID)
			if err != nil {
				t.Errorf("execute: %v", err)
				return
			}
			batches[index], counts[index] = batch, len(jobs)
		})
	}
	wg.Wait()
	if batches[0] == "" || batches[0] != batches[1] || counts != [2]int{1, 1} {
		t.Fatalf("duplicate results = batches %q counts %v", batches, counts)
	}
	var count int
	if err := service.db.QueryRowContext(t.Context(), `SELECT COUNT(*) FROM jobs WHERE proposal_id=? AND credential_id=?`, proposal.ID, credentialID).Scan(&count); err != nil || count != 1 {
		t.Fatalf("persisted jobs = %d, %v", count, err)
	}
}

func TestProposalExpiryBoundaryAndChangedInputs(t *testing.T) {
	service, projectService, mediaService, credentialID, now := newProposalTestService(t, false)
	proposal := prepareProposal(t, service, credentialID)
	*now = proposal.ExpiresAt
	if _, err := service.Approve(t.Context(), proposal.ID); !errors.Is(err, ErrProposalExpired) {
		t.Fatalf("approval at expiry error = %v", err)
	}
	*now = proposal.CreatedAt
	approved, err := service.Approve(t.Context(), proposal.ID)
	if err != nil || approved.ApprovedAt == nil {
		t.Fatalf("approval = %#v, %v", approved, err)
	}
	mediaService.item.ETag = "source-v2"
	if _, _, err := service.Execute(t.Context(), proposal.ID, credentialID); !errors.Is(err, ErrProposalStale) {
		t.Fatalf("changed source error = %v", err)
	}
	mediaService.item.ETag = "source-v1"
	mediaService.item.RootID = "root_b"
	if _, _, err := service.Execute(t.Context(), proposal.ID, credentialID); !errors.Is(err, ErrProposalStale) {
		t.Fatalf("changed root error = %v", err)
	}
	mediaService.item.RootID = "root_a"
	projectService.project.Revision++
	if _, _, err := service.Execute(t.Context(), proposal.ID, credentialID); !errors.Is(err, ErrProposalStale) {
		t.Fatalf("changed project error = %v", err)
	}
}

func TestProposalUnattendedCredentialBypassesOnlyApproval(t *testing.T) {
	service, _, _, credentialID, _ := newProposalTestService(t, true)
	proposal := prepareProposal(t, service, credentialID)
	batch, jobs, err := service.Execute(t.Context(), proposal.ID, credentialID)
	if err != nil || batch == "" || len(jobs) != 1 {
		t.Fatalf("unattended execution = %q %#v %v", batch, jobs, err)
	}
}
