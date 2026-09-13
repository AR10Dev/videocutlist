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
	MediaID         string
	Ranges          []model.Segment
	Export          projects.ExportInput
}

type proposalPayload struct {
	Snapshots []projects.ExportSnapshot `json:"snapshots"`
}

// ExportProposal is immutable except for its one-way app approval timestamp.
type ExportProposal struct {
	ID                 string                    `json:"id"`
	CredentialID       string                    `json:"credentialId"`
	ProjectID          string                    `json:"projectId,omitempty"`
	ProjectRevision    int64                     `json:"projectRevision"`
	MediaID            string                    `json:"mediaId,omitempty"`
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
	if request.CredentialID == "" || request.Export.DestinationID != "" && request.Export.DestinationID != "download" {
		return ExportProposal{}, ErrInvalidInput
	}
	if request.ProjectID != "" {
		return s.prepareProject(ctx, request)
	}
	return s.prepareMedia(ctx, request)
}

func (s *ProposalService) prepareProject(ctx context.Context, request ProposalRequest) (ExportProposal, error) {
	if request.ProjectRevision < 1 || request.MediaID != "" || len(request.Ranges) != 0 {
		return ExportProposal{}, ErrInvalidInput
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
		checked, snapshot, err := s.snapshot(ctx, project.ID, project.Revision, project.SchemaVersion, project.Name, item, media[index], request.Export)
		if err != nil {
			return ExportProposal{}, err
		}
		proposal.Allowed = proposal.Allowed && checked.Allowed
		proposal.Findings = append(proposal.Findings, checked.Findings...)
		proposal.Snapshots = append(proposal.Snapshots, snapshot)
	}
	return s.savePrepared(ctx, proposal, request.Export.CutStrategy)
}

func (s *ProposalService) prepareMedia(ctx context.Context, request ProposalRequest) (ExportProposal, error) {
	if request.MediaID == "" || request.ProjectRevision != 0 || len(request.Export.ItemIDs) != 0 || request.Export.Selection == "gaps" || !validRanges(request.Ranges) {
		return ExportProposal{}, ErrInvalidInput
	}
	media, err := s.Media.Get(ctx, request.MediaID)
	if err != nil || media.RootID == "" {
		return ExportProposal{}, ErrProposalStale
	}
	for _, segment := range request.Ranges {
		if segment.EndMS > media.DurationMS {
			return ExportProposal{}, ErrInvalidInput
		}
	}
	resource := Resource{ProjectMedia: []MediaResource{{ID: media.ID, RootID: media.RootID}}}
	if _, err := s.Credentials.AuthorizeCredential(ctx, request.CredentialID, PermissionExportsPrepare, resource); err != nil {
		return ExportProposal{}, err
	}
	if request.Export.Selection == "" {
		request.Export.Selection = "segments"
	}
	itemID, err := randomIdentifier("i_", 18)
	if err != nil {
		return ExportProposal{}, err
	}
	item := model.ProjectItem{ID: itemID, MediaID: media.ID, Segments: slices.Clone(request.Ranges)}
	proposal := ExportProposal{CredentialID: request.CredentialID, MediaID: media.ID, ProjectRevision: 0, Allowed: true, DestinationID: "download"}
	checked, snapshot, err := s.snapshot(ctx, "", 0, model.ProjectSchemaVersion, "MCP export", item, media, request.Export)
	if err != nil {
		return ExportProposal{}, err
	}
	proposal.Allowed = checked.Allowed
	proposal.Findings = checked.Findings
	proposal.Snapshots = []projects.ExportSnapshot{snapshot}
	return s.savePrepared(ctx, proposal, request.Export.CutStrategy)
}

func (s *ProposalService) snapshot(ctx context.Context, projectID string, revision int64, schemaVersion int, name string, item model.ProjectItem, media projects.Media, input projects.ExportInput) (projects.ExportPreflight, projects.ExportSnapshot, error) {
	item.ExportOptions = model.ExportOptions{
		Mode: input.Mode, Selection: input.Selection, StreamIndexes: slices.Clone(input.StreamIndexes),
		CutStrategy: input.CutStrategy, Container: input.Container, DestinationID: "download", FilenameTemplate: input.FilenameTemplate,
	}
	one := projects.Project{ID: projectID, Revision: revision, Document: model.Document{SchemaVersion: schemaVersion, Name: name, Items: []model.ProjectItem{item}}}
	checked, err := s.Preflight.Preflight(ctx, projectID, one, projects.ExportInput{
		Mode: item.ExportOptions.Mode, Selection: item.ExportOptions.Selection, StreamIndexes: item.ExportOptions.StreamIndexes,
		CutStrategy: item.ExportOptions.CutStrategy, Container: item.ExportOptions.Container, DestinationID: "download", FilenameTemplate: item.ExportOptions.FilenameTemplate,
	})
	if err != nil {
		return projects.ExportPreflight{}, projects.ExportSnapshot{}, err
	}
	item.ExportOptions.StreamIndexes = slices.Clone(checked.Selection)
	item.Segments = exporter.ResolveRanges(item.Segments, item.ExportOptions.Selection, media.DurationMS)
	item.ExportOptions.Selection = "segments"
	return checked, projects.ExportSnapshot{
		ProjectRevision: revision, MediaLabel: media.Name, Item: item,
		Source: projects.SourceSnapshot{MediaID: media.ID, RootID: media.RootID, ETag: media.ETag, SizeBytes: media.SizeBytes, DurationMS: media.DurationMS},
	}, nil
}

func (s *ProposalService) savePrepared(ctx context.Context, proposal ExportProposal, strategy string) (ExportProposal, error) {
	proposal.RequiresReencoding = strategy == "precise_reencode" || strategy == "hybrid_smart_cut"
	proposal.Accuracy = proposalAccuracy(strategy)
	var err error
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
	var projectID sql.NullString
	var reencoding int
	err := s.db.QueryRowContext(ctx, `SELECT id,credential_id,project_id,project_revision,payload_json,findings_json,requires_reencoding,accuracy,destination_id,expires_at,approved_at,created_at FROM export_proposals WHERE id=?`, id).
		Scan(&proposal.ID, &proposal.CredentialID, &projectID, &proposal.ProjectRevision, &payloadJSON, &findingsJSON, &reencoding, &proposal.Accuracy, &proposal.DestinationID, &expires, &approvedValue, &created)
	if errors.Is(err, sql.ErrNoRows) {
		return ExportProposal{}, ErrProposalNotFound
	}
	if err != nil {
		return ExportProposal{}, err
	}
	proposal.ProjectID = projectID.String
	var payload proposalPayload
	if decodeJSON(payloadJSON, &payload) != nil || decodeJSON(findingsJSON, &proposal.Findings) != nil || len(payload.Snapshots) == 0 || proposal.DestinationID != "download" || reencoding < 0 || reencoding > 1 || proposal.ProjectID == "" && proposal.ProjectRevision != 0 || proposal.ProjectID != "" && proposal.ProjectRevision < 1 {
		return ExportProposal{}, ErrProposalData
	}
	proposal.Snapshots = payload.Snapshots
	if proposal.ProjectID == "" {
		proposal.MediaID = payload.Snapshots[0].Source.MediaID
	}
	proposal.RequiresReencoding = reencoding == 1
	proposal.Allowed = true
	for _, finding := range proposal.Findings {
		if finding.Severity == "blocked" {
			proposal.Allowed = false
		}
	}
	var errParse error
	proposal.ExpiresAt, errParse = parseTime(expires)
	if errParse != nil {
		return ExportProposal{}, ErrProposalData
	}
	proposal.CreatedAt, errParse = parseTime(created)
	if errParse != nil {
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

func (s *ProposalService) ListPending(ctx context.Context, limit int) ([]ExportProposal, error) {
	if limit < 1 || limit > 100 {
		limit = 25
	}
	rows, err := s.db.QueryContext(ctx, `SELECT id FROM export_proposals WHERE approved_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT ?`, formatTime(s.currentTime()), limit)
	if err != nil {
		return nil, err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		ids = append(ids, id)
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	proposals := make([]ExportProposal, 0, len(ids))
	for _, id := range ids {
		proposal, err := s.Get(ctx, id)
		if err != nil {
			return nil, err
		}
		proposals = append(proposals, proposal)
	}
	return proposals, nil
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
	resource, err := s.resourceForProposal(ctx, proposal)
	if err != nil {
		return "", nil, err
	}
	var project projects.Project
	if proposal.ProjectID != "" {
		project, err = s.Projects.Get(ctx, proposal.ProjectID)
		if err != nil || project.Revision != proposal.ProjectRevision {
			return "", nil, ErrProposalStale
		}
	}
	credential, err := s.Credentials.AuthorizeCredential(ctx, credentialID, PermissionExportsRun, resource)
	if err != nil {
		return "", nil, err
	}
	if proposal.ApprovedAt == nil && !credential.AllowsUnattendedExport() {
		return "", nil, ErrProposalApprovalNeeded
	}
	jobs := make([]jobqueue.Job, 0, len(proposal.Snapshots))
	batchID := deterministicIdentifier("b_", proposal.ID)
	jobProjectID := proposal.ProjectID
	if jobProjectID == "" {
		jobProjectID = deterministicIdentifier("p_", proposal.ID)
	}
	for _, snapshot := range proposal.Snapshots {
		media, err := s.Media.Get(ctx, snapshot.Source.MediaID)
		if err != nil || projects.ValidateSnapshot(snapshot, media) != nil || media.RootID != snapshot.Source.RootID {
			return "", nil, ErrProposalStale
		}
		projectName, schemaVersion := "MCP export", model.ProjectSchemaVersion
		if proposal.ProjectID != "" {
			projectName, schemaVersion = project.Name, project.SchemaVersion
		}
		one := projects.Project{ID: proposal.ProjectID, Revision: proposal.ProjectRevision, Document: model.Document{SchemaVersion: schemaVersion, Name: projectName, Items: []model.ProjectItem{snapshot.Item}}}
		checked, checkErr := s.Preflight.Preflight(ctx, proposal.ProjectID, one, projects.ExportInput{
			Mode: snapshot.Item.ExportOptions.Mode, Selection: snapshot.Item.ExportOptions.Selection, StreamIndexes: snapshot.Item.ExportOptions.StreamIndexes,
			CutStrategy: snapshot.Item.ExportOptions.CutStrategy, Container: snapshot.Item.ExportOptions.Container, DestinationID: proposal.DestinationID, FilenameTemplate: snapshot.Item.ExportOptions.FilenameTemplate,
		})
		if checkErr != nil {
			return "", nil, checkErr
		}
		if !checked.Allowed {
			return "", nil, ErrProposalBlocked
		}
		if !slices.Equal(checked.Selection, snapshot.Item.ExportOptions.StreamIndexes) {
			return "", nil, ErrProposalStale
		}
		payload, marshalErr := json.Marshal(snapshot)
		if marshalErr != nil {
			return "", nil, marshalErr
		}
		jobs = append(jobs, jobqueue.Job{ID: deterministicIdentifier("j_", proposal.ID+"\x00"+snapshot.Item.ID), BatchID: batchID, Kind: jobqueue.JobExport, ProjectID: jobProjectID, ProjectItemID: snapshot.Item.ID, ProposalID: proposal.ID, CredentialID: credentialID, RequestJSON: string(payload)})
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

// ResourceForProject resolves the complete current project scope for a tool authorization check.
func (s *ProposalService) ResourceForProject(ctx context.Context, projectID string) (Resource, error) {
	project, err := s.Projects.Get(ctx, projectID)
	if err != nil {
		return Resource{}, err
	}
	_, _, resource, err := s.resolveProject(ctx, project, nil)
	return resource, err
}

func (s *ProposalService) ResourceForProposal(ctx context.Context, id string) (Resource, error) {
	proposal, err := s.Get(ctx, id)
	if err != nil {
		return Resource{}, err
	}
	return s.resourceForProposal(ctx, proposal)
}

func (s *ProposalService) resourceForProposal(ctx context.Context, proposal ExportProposal) (Resource, error) {
	if proposal.ProjectID != "" {
		return s.ResourceForProject(ctx, proposal.ProjectID)
	}
	media := make([]MediaResource, 0, len(proposal.Snapshots))
	for _, snapshot := range proposal.Snapshots {
		media = append(media, MediaResource{ID: snapshot.Source.MediaID, RootID: snapshot.Source.RootID})
	}
	return Resource{ProjectMedia: media}, nil
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
	_, err = s.db.ExecContext(ctx, `INSERT INTO export_proposals (id,credential_id,project_id,project_revision,payload_json,findings_json,requires_reencoding,accuracy,destination_id,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`, proposal.ID, proposal.CredentialID, nullableString(proposal.ProjectID), proposal.ProjectRevision, string(payload), string(findings), proposal.RequiresReencoding, proposal.Accuracy, proposal.DestinationID, formatTime(proposal.ExpiresAt), formatTime(proposal.CreatedAt))
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

func validRanges(ranges []model.Segment) bool {
	if len(ranges) == 0 || len(ranges) > 100 {
		return false
	}
	for _, segment := range ranges {
		if segment.StartMS < 0 || segment.EndMS <= segment.StartMS || len(segment.ID) > 64 || len(segment.Label) > 120 {
			return false
		}
	}
	return true
}

func cloneProposal(value ExportProposal) ExportProposal {
	value.Snapshots = slices.Clone(value.Snapshots)
	value.Findings = slices.Clone(value.Findings)
	value.ApprovedAt = cloneTime(value.ApprovedAt)
	return value
}
