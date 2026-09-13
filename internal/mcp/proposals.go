package mcp

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"slices"
	"time"

	exporter "videocutlist/internal/export"
	jobqueue "videocutlist/internal/jobs"
	"videocutlist/internal/projects"
	"videocutlist/internal/projects/model"
)

const ProposalTTL = 15 * time.Minute

var (
	ErrProposalNotFound       = errors.New("export proposal not found")
	ErrProposalExpired        = errors.New("export proposal expired")
	ErrProposalApprovalNeeded = errors.New("export proposal approval required")
	ErrProposalStale          = errors.New("export proposal inputs changed")
	ErrProposalBlocked        = errors.New("export proposal is blocked by preflight")
	ErrProposalData           = errors.New("invalid stored export proposal")
)

type ProposalRequest struct {
	CredentialID    string
	ProjectID       string
	ProjectRevision int64
	Export          projects.ExportInput
}

type proposalPayload struct {
	Snapshots []projects.ExportSnapshot `json:"snapshots"`
}

// ExportProposal is immutable except for its one-way app approval timestamp.
type ExportProposal struct {
	ID                 string                    `json:"id"`
	CredentialID       string                    `json:"credentialId"`
	ProjectID          string                    `json:"projectId"`
	ProjectRevision    int64                     `json:"projectRevision"`
	Snapshots          []projects.ExportSnapshot `json:"snapshots"`
	Findings           []projects.ExportFinding  `json:"findings"`
	Allowed            bool                      `json:"allowed"`
	RequiresReencoding bool                      `json:"requiresReencoding"`
	Accuracy           string                    `json:"accuracy"`
	DestinationID      string                    `json:"destinationId"`
	ExpiresAt          time.Time                 `json:"expiresAt"`
	ApprovedAt         *time.Time                `json:"approvedAt,omitempty"`
	CreatedAt          time.Time                 `json:"createdAt"`
}

type ProposalService struct {
	db          *sql.DB
	Credentials *CredentialStore
	Projects    projects.ProjectService
	Media       projects.MediaCatalog
	Preflight   projects.ExportPreflightService
	Scheduler   *jobqueue.Scheduler
	now         func() time.Time
}

func NewProposalService(db *sql.DB, credentials *CredentialStore, projectService projects.ProjectService, media projects.MediaCatalog, preflight projects.ExportPreflightService, scheduler *jobqueue.Scheduler) (*ProposalService, error) {
	if db == nil || credentials == nil || projectService == nil || media == nil || preflight == nil || scheduler == nil {
		return nil, errors.New("export proposal dependencies are required")
	}
	return &ProposalService{db: db, Credentials: credentials, Projects: projectService, Media: media, Preflight: preflight, Scheduler: scheduler, now: time.Now}, nil
}

func (s *ProposalService) Prepare(ctx context.Context, request ProposalRequest) (ExportProposal, error) {
	if request.CredentialID == "" || request.ProjectID == "" || request.ProjectRevision < 1 || request.Export.DestinationID != "" && request.Export.DestinationID != "download" {
		return ExportProposal{}, ErrProposalBlocked
	}
	project, err := s.Projects.Get(ctx, request.ProjectID)
	if err != nil || project.Revision != request.ProjectRevision {
		return ExportProposal{}, ErrProposalStale
	}
	items, media, resource, err := s.resolveProject(ctx, project, request.Export.ItemIDs)
	if err != nil {
		return ExportProposal{}, err
	}
	if _, err := s.Credentials.AuthorizeCredential(ctx, request.CredentialID, PermissionExportsPrepare, resource); err != nil {
		return ExportProposal{}, err
	}
	proposal := ExportProposal{CredentialID: request.CredentialID, ProjectID: project.ID, ProjectRevision: project.Revision, Allowed: true, DestinationID: "download"}
	for index, item := range items {
		item.ExportOptions = model.ExportOptions{
			Mode: request.Export.Mode, Selection: request.Export.Selection, StreamIndexes: slices.Clone(request.Export.StreamIndexes),
			CutStrategy: request.Export.CutStrategy, Container: request.Export.Container, DestinationID: "download", FilenameTemplate: request.Export.FilenameTemplate,
		}
		one := projects.Project{ID: project.ID, Revision: project.Revision, Document: model.Document{SchemaVersion: project.SchemaVersion, Name: project.Name, Items: []model.ProjectItem{item}}}
		checked, err := s.Preflight.Preflight(ctx, project.ID, one, projects.ExportInput{
			Mode: item.ExportOptions.Mode, Selection: item.ExportOptions.Selection, StreamIndexes: item.ExportOptions.StreamIndexes,
			CutStrategy: item.ExportOptions.CutStrategy, Container: item.ExportOptions.Container, DestinationID: "download", FilenameTemplate: item.ExportOptions.FilenameTemplate,
		})
		if err != nil {
			return ExportProposal{}, err
		}
		proposal.Allowed = proposal.Allowed && checked.Allowed
		proposal.Findings = append(proposal.Findings, checked.Findings...)
		item.ExportOptions.StreamIndexes = slices.Clone(checked.Selection)
		item.Segments = exporter.ResolveRanges(item.Segments, item.ExportOptions.Selection, media[index].DurationMS)
		item.ExportOptions.Selection = "segments"
		proposal.Snapshots = append(proposal.Snapshots, projects.ExportSnapshot{
			ProjectRevision: project.Revision, MediaLabel: media[index].Name, Item: item,
			Source: projects.SourceSnapshot{MediaID: media[index].ID, RootID: media[index].RootID, ETag: media[index].ETag, SizeBytes: media[index].SizeBytes, DurationMS: media[index].DurationMS},
		})
	}
	proposal.RequiresReencoding = request.Export.CutStrategy == "precise_reencode" || request.Export.CutStrategy == "hybrid_smart_cut"
	proposal.Accuracy = proposalAccuracy(request.Export.CutStrategy)
	proposal.ID, err = randomIdentifier("ep_", credentialIDBytes)
	if err != nil {
		return ExportProposal{}, err
	}
	proposal.CreatedAt = s.currentTime()
	proposal.ExpiresAt = proposal.CreatedAt.Add(ProposalTTL)
	if err := s.insert(ctx, proposal); err != nil {
		return ExportProposal{}, err
	}
	return cloneProposal(proposal), nil
}

func (s *ProposalService) Get(ctx context.Context, id string) (ExportProposal, error) {
	if !validProposalID(id) {
		return ExportProposal{}, ErrProposalNotFound
	}
	var proposal ExportProposal
	var payloadJSON, findingsJSON, expires, approved, created string
	var approvedValue sql.NullString
	var reencoding int
	err := s.db.QueryRowContext(ctx, `SELECT id,credential_id,project_id,project_revision,payload_json,findings_json,requires_reencoding,accuracy,destination_id,expires_at,approved_at,created_at FROM export_proposals WHERE id=?`, id).
		Scan(&proposal.ID, &proposal.CredentialID, &proposal.ProjectID, &proposal.ProjectRevision, &payloadJSON, &findingsJSON, &reencoding, &proposal.Accuracy, &proposal.DestinationID, &expires, &approvedValue, &created)
	if errors.Is(err, sql.ErrNoRows) {
		return ExportProposal{}, ErrProposalNotFound
	}
	if err != nil {
		return ExportProposal{}, err
	}
	var payload proposalPayload
	if decodeJSON(payloadJSON, &payload) != nil || decodeJSON(findingsJSON, &proposal.Findings) != nil || len(payload.Snapshots) == 0 || proposal.ProjectRevision < 1 || proposal.DestinationID != "download" || reencoding < 0 || reencoding > 1 {
		return ExportProposal{}, ErrProposalData
	}
	proposal.Snapshots = payload.Snapshots
	proposal.RequiresReencoding = reencoding == 1
	proposal.Allowed = true
	for _, finding := range proposal.Findings {
		if finding.Severity == "blocked" {
			proposal.Allowed = false
		}
	}
	proposal.ExpiresAt, err = parseTime(expires)
	if err != nil {
		return ExportProposal{}, ErrProposalData
	}
	proposal.CreatedAt, err = parseTime(created)
	if err != nil {
		return ExportProposal{}, ErrProposalData
	}
	approved = approvedValue.String
	if approvedValue.Valid {
		value, parseErr := parseTime(approved)
		if parseErr != nil {
			return ExportProposal{}, ErrProposalData
		}
		proposal.ApprovedAt = new(value)
	}
	return cloneProposal(proposal), nil
}

func (s *ProposalService) Approve(ctx context.Context, id string) (ExportProposal, error) {
	proposal, err := s.Get(ctx, id)
	if err != nil {
		return ExportProposal{}, err
	}
	if !proposal.ExpiresAt.After(s.currentTime()) {
		return ExportProposal{}, ErrProposalExpired
	}
	now := s.currentTime()
	result, err := s.db.ExecContext(ctx, `UPDATE export_proposals
SET approved_at=COALESCE(approved_at,?)
WHERE id=? AND expires_at > ?`, formatTime(now), id, formatTime(now))
	if err != nil {
		return ExportProposal{}, err
	}
	updated, err := result.RowsAffected()
	if err != nil {
		return ExportProposal{}, err
	}
	if updated != 1 {
		return ExportProposal{}, ErrProposalExpired
	}
	return s.Get(ctx, id)
}

func (s *ProposalService) Execute(ctx context.Context, id, credentialID string) (string, []projects.Job, error) {
	proposal, err := s.Get(ctx, id)
	if err != nil {
		return "", nil, err
	}
	if credentialID != proposal.CredentialID {
		return "", nil, ErrResourceDenied
	}
	if !proposal.ExpiresAt.After(s.currentTime()) {
		return "", nil, ErrProposalExpired
	}
	project, err := s.Projects.Get(ctx, proposal.ProjectID)
	if err != nil || project.Revision != proposal.ProjectRevision {
		return "", nil, ErrProposalStale
	}
	_, currentMedia, resource, err := s.resolveProject(ctx, project, nil)
	if err != nil {
		return "", nil, ErrProposalStale
	}
	credential, err := s.Credentials.AuthorizeCredential(ctx, credentialID, PermissionExportsRun, resource)
	if err != nil {
		return "", nil, err
	}
	if proposal.ApprovedAt == nil && !credential.AllowsUnattendedExport() {
		return "", nil, ErrProposalApprovalNeeded
	}
	byID := make(map[string]projects.Media, len(currentMedia))
	for _, media := range currentMedia {
		byID[media.ID] = media
	}
	jobs := make([]jobqueue.Job, 0, len(proposal.Snapshots))
	batchID := deterministicIdentifier("b_", proposal.ID)
	for _, snapshot := range proposal.Snapshots {
		media, ok := byID[snapshot.Source.MediaID]
		if !ok || projects.ValidateSnapshot(snapshot, media) != nil || media.RootID != snapshot.Source.RootID {
			return "", nil, ErrProposalStale
		}
		one := projects.Project{ID: proposal.ProjectID, Revision: proposal.ProjectRevision, Document: model.Document{SchemaVersion: project.SchemaVersion, Name: project.Name, Items: []model.ProjectItem{snapshot.Item}}}
		checked, checkErr := s.Preflight.Preflight(ctx, proposal.ProjectID, one, projects.ExportInput{
			Mode: snapshot.Item.ExportOptions.Mode, Selection: snapshot.Item.ExportOptions.Selection, StreamIndexes: snapshot.Item.ExportOptions.StreamIndexes,
			CutStrategy: snapshot.Item.ExportOptions.CutStrategy, Container: snapshot.Item.ExportOptions.Container, DestinationID: proposal.DestinationID, FilenameTemplate: snapshot.Item.ExportOptions.FilenameTemplate,
		})
		if checkErr != nil || !checked.Allowed || !slices.Equal(checked.Selection, snapshot.Item.ExportOptions.StreamIndexes) {
			return "", nil, ErrProposalStale
		}
		payload, marshalErr := json.Marshal(snapshot)
		if marshalErr != nil {
			return "", nil, marshalErr
		}
		jobs = append(jobs, jobqueue.Job{ID: deterministicIdentifier("j_", proposal.ID+"\x00"+snapshot.Item.ID), BatchID: batchID, Kind: jobqueue.JobExport, ProjectID: proposal.ProjectID, ProjectItemID: snapshot.Item.ID, ProposalID: proposal.ID, CredentialID: credentialID, RequestJSON: string(payload)})
	}
	created, err := s.Scheduler.SubmitProposal(ctx, proposal.ID, credentialID, jobs)
	if err != nil {
		return "", nil, err
	}
	result := make([]projects.Job, len(created))
	for index, job := range created {
		result[index] = projects.Job{ID: job.ID, BatchID: job.BatchID, ProjectItemID: job.ProjectItemID, Type: string(job.Kind), State: string(job.State), CreatedAt: job.CreatedAt, UpdatedAt: job.UpdatedAt}
	}
	return batchID, result, nil
}

func (s *ProposalService) resolveProject(ctx context.Context, project projects.Project, selectedIDs []string) ([]model.ProjectItem, []projects.Media, Resource, error) {
	selected := make(map[string]struct{}, len(selectedIDs))
	for _, id := range selectedIDs {
		if id == "" {
			return nil, nil, Resource{}, ErrProposalStale
		}
		selected[id] = struct{}{}
	}
	items := make([]model.ProjectItem, 0, len(project.Items))
	selectedMedia := make([]projects.Media, 0, len(project.Items))
	all := make([]MediaResource, 0, len(project.Items))
	for _, item := range project.Items {
		media, err := s.Media.Get(ctx, item.MediaID)
		if err != nil || media.RootID == "" {
			return nil, nil, Resource{}, ErrProposalStale
		}
		all = append(all, MediaResource{ID: media.ID, RootID: media.RootID})
		if len(selected) == 0 {
			items = append(items, item)
			selectedMedia = append(selectedMedia, media)
		} else if _, ok := selected[item.ID]; ok {
			items = append(items, item)
			selectedMedia = append(selectedMedia, media)
			delete(selected, item.ID)
		}
	}
	if len(items) == 0 || len(selected) != 0 {
		return nil, nil, Resource{}, ErrProposalStale
	}
	return items, selectedMedia, Resource{ProjectID: project.ID, ProjectMedia: all}, nil
}

func (s *ProposalService) insert(ctx context.Context, proposal ExportProposal) error {
	payload, err := json.Marshal(proposalPayload{Snapshots: proposal.Snapshots})
	if err != nil {
		return err
	}
	findings, err := json.Marshal(proposal.Findings)
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, `INSERT INTO export_proposals (id,credential_id,project_id,project_revision,payload_json,findings_json,requires_reencoding,accuracy,destination_id,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`, proposal.ID, proposal.CredentialID, proposal.ProjectID, proposal.ProjectRevision, string(payload), string(findings), proposal.RequiresReencoding, proposal.Accuracy, proposal.DestinationID, formatTime(proposal.ExpiresAt), formatTime(proposal.CreatedAt))
	return err
}

func (s *ProposalService) currentTime() time.Time { return s.now().UTC() }

func proposalAccuracy(strategy string) string {
	switch strategy {
	case "precise_reencode":
		return "frame_exact"
	case "hybrid_smart_cut":
		return "mixed"
	default:
		return "keyframe_limited"
	}
}

func deterministicIdentifier(prefix, value string) string {
	sum := sha256.Sum256([]byte(value))
	return prefix + base64.RawURLEncoding.EncodeToString(sum[:18])
}

func validProposalID(value string) bool {
	return len(value) > 3 && value[:3] == "ep_" && validSafeIdentifier(value)
}

func cloneProposal(value ExportProposal) ExportProposal {
	value.Snapshots = slices.Clone(value.Snapshots)
	value.Findings = slices.Clone(value.Findings)
	value.ApprovedAt = cloneTime(value.ApprovedAt)
	return value
}
