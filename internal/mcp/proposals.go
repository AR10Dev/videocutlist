package mcp

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"time"
	"videocutlist/internal/jobs/view"

	store "videocutlist/internal/db"
	exporter "videocutlist/internal/export"
	jobs "videocutlist/internal/jobs"
	jobqueue "videocutlist/internal/jobs/model"
	librarymedia "videocutlist/internal/library/media"
	"videocutlist/internal/projects"
	"videocutlist/internal/projects/model"
)

const (
	ProposalTTL          = 15 * time.Minute
	proposalPageDefault  = 25
	proposalPageLimit    = 100
	proposalItemLimit    = 20
	proposalRangeLimit   = 100
	proposalClipLimitMS  = 10 * 60 * 1000
	proposalTotalLimitMS = 30 * 60 * 1000
)

var (
	ErrProposalNotFound       = errors.New("export proposal not found")
	ErrProposalExpired        = errors.New("export proposal expired")
	ErrProposalApprovalNeeded = errors.New("export proposal approval required")
	ErrProposalStale          = errors.New("export proposal inputs changed")
	ErrProposalBlocked        = errors.New("export proposal is blocked by preflight")
	ErrProposalData           = errors.New("invalid stored export proposal")
	ErrInvalidProposalCursor  = errors.New("invalid export proposal cursor")
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
	Snapshots []exporter.ExportSnapshot `json:"snapshots"`
}

// ExportProposal is immutable except for its one-way app approval timestamp.
type ExportProposal struct {
	ID                 string                    `json:"id"`
	CredentialID       string                    `json:"credentialId"`
	ProjectID          string                    `json:"projectId,omitempty"`
	ProjectRevision    int64                     `json:"projectRevision"`
	MediaID            string                    `json:"mediaId,omitempty"`
	Snapshots          []exporter.ExportSnapshot `json:"snapshots"`
	Findings           []exporter.Finding        `json:"findings"`
	Allowed            bool                      `json:"allowed"`
	RequiresReencoding bool                      `json:"requiresReencoding"`
	Accuracy           string                    `json:"accuracy"`
	DestinationID      string                    `json:"destinationId"`
	ExpiresAt          time.Time                 `json:"expiresAt"`
	ApprovedAt         *time.Time                `json:"approvedAt,omitempty"`
	CreatedAt          time.Time                 `json:"createdAt"`
}

// ProposalRepository persists proposal documents and their conditional approval.
type ProposalRepository interface {
	InsertProposal(context.Context, store.MCPProposalRecord) error
	GetProposal(context.Context, string) (store.MCPProposalRecord, error)
	ListPendingProposals(context.Context, string, string, string, int) ([]store.MCPProposalPageEntry, error)
	ApproveProposal(context.Context, string, string) (store.MCPProposalRecord, bool, error)
}

type ProposalService struct {
	repository  ProposalRepository
	Credentials *CredentialStore
	Projects    projects.ProjectService
	Media       librarymedia.MediaCatalog
	Preflight   projects.ExportPreflightService
	Scheduler   *jobs.Scheduler
	now         func() time.Time
}

func NewProposalService(repository ProposalRepository, credentials *CredentialStore, projectService projects.ProjectService, media librarymedia.MediaCatalog, preflight projects.ExportPreflightService, scheduler *jobs.Scheduler) (*ProposalService, error) {
	if repository == nil || credentials == nil || projectService == nil || media == nil || preflight == nil || scheduler == nil {
		return nil, errors.New("export proposal dependencies are required")
	}
	return &ProposalService{repository: repository, Credentials: credentials, Projects: projectService, Media: media, Preflight: preflight, Scheduler: scheduler, now: time.Now}, nil
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
	if len(items) > proposalItemLimit {
		return ExportProposal{}, ErrInvalidInput
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
	if !validProposalSnapshots(proposal.Snapshots) {
		return ExportProposal{}, ErrInvalidInput
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
	proposal.Snapshots = []exporter.ExportSnapshot{snapshot}
	if !validProposalSnapshots(proposal.Snapshots) {
		return ExportProposal{}, ErrInvalidInput
	}
	return s.savePrepared(ctx, proposal, request.Export.CutStrategy)
}

func (s *ProposalService) snapshot(ctx context.Context, projectID string, revision int64, schemaVersion int, name string, item model.ProjectItem, media librarymedia.Media, input projects.ExportInput) (exporter.PreflightResult, exporter.ExportSnapshot, error) {
	item.ExportOptions = model.ExportOptions{
		Mode: input.Mode, Selection: input.Selection, StreamIndexes: slices.Clone(input.StreamIndexes),
		CutStrategy: input.CutStrategy, Container: input.Container, DestinationID: "download", FilenameTemplate: input.FilenameTemplate,
	}
	one := projects.Project{ID: projectID, Revision: revision, Document: model.Document{SchemaVersion: schemaVersion, Name: name, Items: []model.ProjectItem{item}}}
	checked, err := s.Preflight.Preflight(ctx, one, projects.ExportInput{
		Mode: item.ExportOptions.Mode, Selection: item.ExportOptions.Selection, StreamIndexes: item.ExportOptions.StreamIndexes,
		CutStrategy: item.ExportOptions.CutStrategy, Container: item.ExportOptions.Container, DestinationID: "download", FilenameTemplate: item.ExportOptions.FilenameTemplate,
	})
	if err != nil {
		return exporter.PreflightResult{}, exporter.ExportSnapshot{}, err
	}
	item.ExportOptions.StreamIndexes = slices.Clone(checked.Selection)
	item.Segments = exporter.ResolveRanges(item.Segments, item.ExportOptions.Selection, media.DurationMS)
	item.ExportOptions.Selection = "segments"
	return checked, exporter.ExportSnapshot{
		ProjectRevision: revision, MediaLabel: media.Name, Item: item,
		Source: exporter.SourceSnapshot{MediaID: media.ID, RootID: media.RootID, ETag: media.ETag, SizeBytes: media.SizeBytes, DurationMS: media.DurationMS},
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
	record, err := s.repository.GetProposal(ctx, id)
	if errors.Is(err, store.ErrMCPProposalNotFound) {
		return ExportProposal{}, ErrProposalNotFound
	}
	if err != nil {
		return ExportProposal{}, err
	}
	return proposalFromStorageRecord(record)
}

func proposalFromStorageRecord(record store.MCPProposalRecord) (ExportProposal, error) {
	proposal := ExportProposal{ID: record.ID, CredentialID: record.CredentialID, ProjectRevision: record.ProjectRevision, Accuracy: record.Accuracy, DestinationID: record.DestinationID}
	if record.ProjectID != nil {
		proposal.ProjectID = *record.ProjectID
	}
	var payload proposalPayload
	if decodeJSON(record.PayloadJSON, &payload) != nil || decodeJSON(record.FindingsJSON, &proposal.Findings) != nil || len(payload.Snapshots) == 0 || proposal.DestinationID != "download" || record.RequiresReencoding < 0 || record.RequiresReencoding > 1 || proposal.ProjectID == "" && proposal.ProjectRevision != 0 || proposal.ProjectID != "" && proposal.ProjectRevision < 1 {
		return ExportProposal{}, ErrProposalData
	}
	proposal.Snapshots = payload.Snapshots
	if proposal.ProjectID == "" {
		proposal.MediaID = payload.Snapshots[0].Source.MediaID
	}
	proposal.RequiresReencoding = record.RequiresReencoding == 1
	proposal.Allowed = true
	for _, finding := range proposal.Findings {
		if finding.Severity == "blocked" {
			proposal.Allowed = false
		}
	}
	var err error
	if proposal.ExpiresAt, err = parseTime(record.ExpiresAt); err != nil {
		return ExportProposal{}, ErrProposalData
	}
	if proposal.CreatedAt, err = parseTime(record.CreatedAt); err != nil {
		return ExportProposal{}, ErrProposalData
	}
	if record.ApprovedAt != nil {
		value, err := parseTime(*record.ApprovedAt)
		if err != nil {
			return ExportProposal{}, ErrProposalData
		}
		proposal.ApprovedAt = new(value)
	}
	return cloneProposal(proposal), nil
}

func (s *ProposalService) ListPending(ctx context.Context, cursor string, limit int) ([]ExportProposal, *string, error) {
	if limit < 1 || limit > proposalPageLimit {
		limit = proposalPageDefault
	}
	position, err := decodeProposalCursor(cursor)
	if err != nil {
		return nil, nil, err
	}
	var cursorCreatedAt, cursorID string
	if cursor != "" {
		cursorCreatedAt, cursorID = position.createdAt, position.id
	}
	rowsList, err := s.repository.ListPendingProposals(ctx, formatTime(s.currentTime()), cursorCreatedAt, cursorID, limit+1)
	if err != nil {
		return nil, nil, err
	}
	var next *string
	if len(rowsList) > limit {
		cursor := encodeProposalCursor(rowsList[limit-1].CreatedAt, rowsList[limit-1].ID)
		next = new(cursor)
		rowsList = rowsList[:limit]
	}
	proposals := make([]ExportProposal, 0, len(rowsList))
	for _, row := range rowsList {
		proposal, err := s.Get(ctx, row.ID)
		if err != nil {
			return nil, nil, err
		}
		proposals = append(proposals, proposal)
	}
	return proposals, next, nil
}

type proposalCursor struct {
	createdAt string
	id        string
}

func encodeProposalCursor(createdAt, id string) string {
	return base64.RawURLEncoding.EncodeToString([]byte(createdAt + "\x00" + id))
}

func decodeProposalCursor(value string) (proposalCursor, error) {
	if value == "" {
		return proposalCursor{}, nil
	}
	if len(value) > 256 {
		return proposalCursor{}, ErrInvalidProposalCursor
	}
	raw, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		return proposalCursor{}, ErrInvalidProposalCursor
	}
	createdAt, id, ok := strings.Cut(string(raw), "\x00")
	if !ok || !validProposalID(id) {
		return proposalCursor{}, ErrInvalidProposalCursor
	}
	if _, err := parseTime(createdAt); err != nil {
		return proposalCursor{}, ErrInvalidProposalCursor
	}
	return proposalCursor{createdAt: createdAt, id: id}, nil
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
	record, updated, err := s.repository.ApproveProposal(ctx, id, formatTime(now))
	if err != nil {
		return ExportProposal{}, err
	}
	if !updated {
		return ExportProposal{}, ErrProposalExpired
	}
	return proposalFromStorageRecord(record)
}

func (s *ProposalService) Execute(ctx context.Context, id, credentialID string) (string, []view.Job, error) {
	proposal, err := s.Get(ctx, id)
	if err != nil {
		return "", nil, err
	}
	if !validProposalSnapshots(proposal.Snapshots) {
		return "", nil, ErrProposalData
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
		if err != nil || exporter.ValidateSnapshot(snapshot, media) != nil || media.RootID != snapshot.Source.RootID {
			return "", nil, ErrProposalStale
		}
		projectName, schemaVersion := "MCP export", model.ProjectSchemaVersion
		if proposal.ProjectID != "" {
			projectName, schemaVersion = project.Name, project.SchemaVersion
		}
		one := projects.Project{ID: proposal.ProjectID, Revision: proposal.ProjectRevision, Document: model.Document{SchemaVersion: schemaVersion, Name: projectName, Items: []model.ProjectItem{snapshot.Item}}}
		checked, checkErr := s.Preflight.Preflight(ctx, one, projects.ExportInput{
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
	result := make([]view.Job, len(created))
	for index, job := range created {
		result[index] = view.Job{
			ID: job.ID, BatchID: job.BatchID, ProjectItemID: job.ProjectItemID,
			Type: string(job.Kind), State: string(job.State),
			CreatedAt: job.CreatedAt, UpdatedAt: job.UpdatedAt,
		}
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

func (s *ProposalService) resolveProject(ctx context.Context, project projects.Project, selectedIDs []string) ([]model.ProjectItem, []librarymedia.Media, Resource, error) {
	selectAll := len(selectedIDs) == 0
	selected := make(map[string]struct{}, len(selectedIDs))
	for _, id := range selectedIDs {
		if id == "" {
			return nil, nil, Resource{}, ErrProposalStale
		}
		if _, duplicate := selected[id]; duplicate {
			return nil, nil, Resource{}, ErrProposalStale
		}
		selected[id] = struct{}{}
	}
	items := make([]model.ProjectItem, 0, len(project.Items))
	selectedMedia := make([]librarymedia.Media, 0, len(project.Items))
	all := make([]MediaResource, 0, len(project.Items))
	for _, item := range project.Items {
		media, err := s.Media.Get(ctx, item.MediaID)
		if err != nil || media.RootID == "" {
			return nil, nil, Resource{}, ErrProposalStale
		}
		all = append(all, MediaResource{ID: media.ID, RootID: media.RootID})
		if selectAll {
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
	var projectID *string
	if proposal.ProjectID != "" {
		projectID = new(proposal.ProjectID)
	}
	return s.repository.InsertProposal(ctx, store.MCPProposalRecord{
		ID: proposal.ID, CredentialID: proposal.CredentialID, ProjectID: projectID,
		ProjectRevision: proposal.ProjectRevision, PayloadJSON: string(payload), FindingsJSON: string(findings),
		RequiresReencoding: boolInt(proposal.RequiresReencoding), Accuracy: proposal.Accuracy,
		DestinationID: proposal.DestinationID, ExpiresAt: formatTime(proposal.ExpiresAt), CreatedAt: formatTime(proposal.CreatedAt),
	})
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

// validProposalSnapshots checks the frozen selection, not the raw cutlist: gaps
// can produce more ranges (and a longer duration) than their source segments.
func validProposalSnapshots(snapshots []exporter.ExportSnapshot) bool {
	if len(snapshots) == 0 || len(snapshots) > proposalItemLimit {
		return false
	}
	var total int64
	for _, snapshot := range snapshots {
		segments := snapshot.Item.Segments
		if len(segments) == 0 || len(segments) > proposalRangeLimit {
			return false
		}
		for _, segment := range segments {
			if segment.StartMS < 0 || segment.EndMS <= segment.StartMS || segment.EndMS > snapshot.Source.DurationMS {
				return false
			}
			duration := segment.EndMS - segment.StartMS
			if duration > proposalClipLimitMS || duration > proposalTotalLimitMS-total {
				return false
			}
			total += duration
		}
	}
	return true
}

func validRanges(ranges []model.Segment) bool {
	if len(ranges) == 0 || len(ranges) > proposalRangeLimit {
		return false
	}
	// ResolveRanges would drop every explicitly excluded segment, producing a
	// snapshot with zero segments that Run later rejects; refuse it up front.
	included := false
	for _, segment := range ranges {
		if segment.StartMS < 0 || segment.EndMS <= segment.StartMS || len(segment.ID) > 64 || len(segment.Label) > 120 {
			return false
		}
		if segment.IsIncluded() {
			included = true
		}
	}
	return included
}

func cloneProposal(value ExportProposal) ExportProposal {
	value.Snapshots = slices.Clone(value.Snapshots)
	value.Findings = slices.Clone(value.Findings)
	value.ApprovedAt = cloneTime(value.ApprovedAt)
	return value
}
