package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"

	"videocutlist/internal/exportpolicy"
	jobqueue "videocutlist/internal/jobs"
	"videocutlist/internal/projects"
	"videocutlist/internal/projects/model"
)

const exportDownloadPath = "/mcp/download/"

// ExportTools wires the existing proposal, job, and download services into the
// small, scoped MCP export workflow.
func ExportTools(proposals *ProposalService, jobs interface {
	Get(context.Context, string) (jobqueue.Job, error)
	Cancel(context.Context, string) (jobqueue.Job, error)
}, downloads projects.ExportDownloadService) []Tool {
	if proposals == nil || jobs == nil || downloads == nil {
		return nil
	}
	return []Tool{
		{Name: "propose_export", Description: "Validate and save an authorized export proposal to the download destination.", Permission: PermissionExportsPrepare, InputSchema: proposeExportSchema(), Resource: func(ctx Context, raw json.RawMessage) (Resource, error) {
			args, err := proposalArguments(raw)
			if err != nil {
				return Resource{}, err
			}
			if args.ProjectID != "" {
				return proposals.ResourceForProject(ctx.Request.Context(), args.ProjectID)
			}
			media, err := proposals.Media.Get(ctx.Request.Context(), args.MediaID)
			if err != nil {
				return Resource{}, ErrResourceDenied
			}
			return Resource{ProjectMedia: []MediaResource{{ID: media.ID, RootID: media.RootID}}}, nil
		}, Call: func(ctx Context, raw json.RawMessage) (ToolResult, error) {
			args, err := proposalArguments(raw)
			if err != nil {
				return ToolResult{}, err
			}
			proposal, err := proposals.Prepare(ctx.Request.Context(), ProposalRequest{CredentialID: ctx.Credential.ID, ProjectID: args.ProjectID, ProjectRevision: args.ProjectRevision, MediaID: args.MediaID, Ranges: args.Ranges, Export: args.Export})
			if err != nil {
				return ToolResult{}, err
			}
			return toolData("Export proposed.", proposal), nil
		}},
		{Name: "start_export", Description: "Start an approved export proposal; retries return the same jobs.", Permission: PermissionExportsRun, InputSchema: proposalIDSchema(), Resource: func(ctx Context, raw json.RawMessage) (Resource, error) {
			id, err := proposalIDArgument(raw)
			if err != nil {
				return Resource{}, err
			}
			proposal, err := proposals.Get(ctx.Request.Context(), id)
			if err != nil || proposal.CredentialID != ctx.Credential.ID {
				return Resource{}, ErrResourceDenied
			}
			return proposals.ResourceForProposal(ctx.Request.Context(), proposal.ID)
		}, Call: func(ctx Context, raw json.RawMessage) (ToolResult, error) {
			id, err := proposalIDArgument(raw)
			if err != nil {
				return ToolResult{}, err
			}
			batchID, created, err := proposals.Execute(ctx.Request.Context(), id, ctx.Credential.ID)
			if err != nil {
				return ToolResult{}, err
			}
			return toolData("Export started.", map[string]any{"batchId": batchID, "jobs": created}), nil
		}},
		{Name: "get_job", Description: "Get a current-scope job created by this credential.", Permission: PermissionJobsRead, InputSchema: jobIDSchema(), Resource: ownedJobResource(proposals, jobs, false), Call: func(ctx Context, raw json.RawMessage) (ToolResult, error) {
			job, err := authorizeOwnedJob(ctx, proposals, jobs, raw, PermissionJobsRead, false)
			if err != nil {
				return ToolResult{}, err
			}
			return toolData("Job retrieved.", safeJob(job)), nil
		}},
		{Name: "cancel_job", Description: "Cancel a queued or running current-scope job created by this credential.", Permission: PermissionJobsCancel, InputSchema: jobIDSchema(), Resource: ownedJobResource(proposals, jobs, false), Call: func(ctx Context, raw json.RawMessage) (ToolResult, error) {
			job, err := authorizeOwnedJob(ctx, proposals, jobs, raw, PermissionJobsCancel, false)
			if err != nil {
				return ToolResult{}, err
			}
			if _, err := jobs.Cancel(ctx.Request.Context(), job.ID); err != nil && !errors.Is(err, jobqueue.ErrJobState) {
				return ToolResult{}, err
			}
			job, err = jobs.Get(ctx.Request.Context(), job.ID)
			if err != nil {
				return ToolResult{}, err
			}
			return toolData("Job cancelled.", safeJob(job)), nil
		}},
		{Name: "get_export_download", Description: "Return a protected URL for a completed, authorized export download.", Permission: PermissionExportsDownload, InputSchema: downloadSchema(), Resource: ownedJobResource(proposals, jobs, true), Call: func(ctx Context, raw json.RawMessage) (ToolResult, error) {
			job, err := authorizeOwnedJob(ctx, proposals, jobs, raw, PermissionExportsDownload, true)
			if err != nil {
				return ToolResult{}, err
			}
			position, err := downloadPosition(raw)
			if err != nil {
				return ToolResult{}, err
			}
			return toolData("Download with the same bearer token.", map[string]any{"url": exportDownloadPath + job.ID + "/" + strconv.Itoa(position)}), nil
		}},
	}
}

type exportProposalArguments struct {
	ProjectID       string                  `json:"projectId"`
	ProjectRevision int64                   `json:"projectRevision"`
	MediaID         string                  `json:"mediaId"`
	Ranges          []model.Segment         `json:"ranges"`
	Export          projects.ExportInput    `json:"export"`
}

func proposalArguments(raw json.RawMessage) (exportProposalArguments, error) {
	var args exportProposalArguments
	if err := decodeToolArguments(raw, &args); err != nil || !validMCPExport(args.Export) {
		return exportProposalArguments{}, ErrInvalidInput
	}
	projectSource := args.ProjectID != "" && validSafeIdentifier(args.ProjectID) && args.ProjectRevision >= 1 && args.MediaID == "" && len(args.Ranges) == 0
	mediaSource := args.ProjectID == "" && args.ProjectRevision == 0 && validSafeIdentifier(args.MediaID) && validRanges(args.Ranges) && args.Export.Selection != "gaps" && len(args.Export.ItemIDs) == 0
	if projectSource == mediaSource {
		return exportProposalArguments{}, ErrInvalidInput
	}
	return args, nil
}

func validMCPExport(value projects.ExportInput) bool {
	if _, ok := exportpolicy.For(value.Container); !ok {
		return false
	}
	if value.DestinationID != "download" || value.Mode != "merge" && value.Mode != "separate" || value.Selection != "" && value.Selection != "segments" && value.Selection != "gaps" || value.CutStrategy != "stream_copy_preferred" && value.CutStrategy != "precise_reencode" && value.CutStrategy != "hybrid_smart_cut" || len(value.ItemIDs) > 100 || len(value.StreamIndexes) > 100 || len(value.FilenameTemplate) > 160 || strings.ContainsAny(value.FilenameTemplate, "\\/\x00") {
		return false
	}
	seenItems := make(map[string]struct{}, len(value.ItemIDs))
	for _, id := range value.ItemIDs {
		if !validSafeIdentifier(id) {
			return false
		}
		if _, ok := seenItems[id]; ok {
			return false
		}
		seenItems[id] = struct{}{}
	}
	seenStreams := make(map[int]struct{}, len(value.StreamIndexes))
	for _, index := range value.StreamIndexes {
		if index < 0 {
			return false
		}
		if _, ok := seenStreams[index]; ok {
			return false
		}
		seenStreams[index] = struct{}{}
	}
	return true
}

func proposalIDArgument(raw json.RawMessage) (string, error) {
	var args struct {
		ProposalID string `json:"proposalId"`
	}
	if err := decodeToolArguments(raw, &args); err != nil || !validProposalID(args.ProposalID) {
		return "", ErrInvalidInput
	}
	return args.ProposalID, nil
}

func jobIDArgument(raw json.RawMessage) (string, error) {
	var args struct {
		JobID string `json:"jobId"`
	}
	if err := decodeToolArguments(raw, &args); err != nil || !strings.HasPrefix(args.JobID, "j_") || !validSafeIdentifier(args.JobID) {
		return "", ErrInvalidInput
	}
	return args.JobID, nil
}

func downloadPosition(raw json.RawMessage) (int, error) {
	var args struct {
		JobID    string `json:"jobId"`
		Position int    `json:"position"`
	}
	if err := decodeToolArguments(raw, &args); err != nil || !strings.HasPrefix(args.JobID, "j_") || !validSafeIdentifier(args.JobID) || args.Position < 0 || args.Position > 99 {
		return 0, ErrInvalidInput
	}
	return args.Position, nil
}

func ownedJobResource(proposals *ProposalService, jobs interface {
	Get(context.Context, string) (jobqueue.Job, error)
	Cancel(context.Context, string) (jobqueue.Job, error)
}, download bool) func(Context, json.RawMessage) (Resource, error) {
	return func(ctx Context, raw json.RawMessage) (Resource, error) {
		job, err := ownedMCPJob(ctx.Request.Context(), jobs, ctx.Credential.ID, raw, download)
		if err != nil {
			return Resource{}, err
		}
		if job.ProposalID != "" {
			return proposals.ResourceForProposal(ctx.Request.Context(), job.ProposalID)
		}
		return proposals.ResourceForProject(ctx.Request.Context(), job.ProjectID)
	}
}

func authorizeOwnedJob(ctx Context, proposals *ProposalService, jobs interface {
	Get(context.Context, string) (jobqueue.Job, error)
	Cancel(context.Context, string) (jobqueue.Job, error)
}, raw json.RawMessage, permission Permission, download bool) (jobqueue.Job, error) {
	job, err := ownedMCPJob(ctx.Request.Context(), jobs, ctx.Credential.ID, raw, download)
	if err != nil {
		return jobqueue.Job{}, err
	}
	resource, err := proposals.ResourceForProject(ctx.Request.Context(), job.ProjectID)
	if job.ProposalID != "" {
		resource, err = proposals.ResourceForProposal(ctx.Request.Context(), job.ProposalID)
	}
	if err != nil {
		return jobqueue.Job{}, err
	}
	if _, err := proposals.Credentials.AuthorizeCredential(ctx.Request.Context(), ctx.Credential.ID, permission, resource); err != nil {
		return jobqueue.Job{}, err
	}
	return job, nil
}

func ownedMCPJob(ctx context.Context, jobs interface {
	Get(context.Context, string) (jobqueue.Job, error)
	Cancel(context.Context, string) (jobqueue.Job, error)
}, credentialID string, raw json.RawMessage, download bool) (jobqueue.Job, error) {
	var args struct {
		JobID    string `json:"jobId"`
		Position *int   `json:"position"`
	}
	if err := decodeToolArguments(raw, &args); err != nil || !strings.HasPrefix(args.JobID, "j_") || !validSafeIdentifier(args.JobID) || download && (args.Position == nil || *args.Position < 0 || *args.Position > 99) || !download && args.Position != nil {
		return jobqueue.Job{}, ErrInvalidInput
	}
	job, err := jobs.Get(ctx, args.JobID)
	if err != nil || job.CredentialID != credentialID || job.ProjectID == "" {
		return jobqueue.Job{}, ErrResourceDenied
	}
	if job.Kind != jobqueue.JobExport && job.Kind != jobqueue.JobDetect || download && job.Kind != jobqueue.JobExport {
		return jobqueue.Job{}, ErrResourceDenied
	}
	return job, nil
}

func safeJob(job jobqueue.Job) map[string]any {
	result := map[string]any{"id": job.ID, "batchId": job.BatchID, "projectId": job.ProjectID, "projectItemId": job.ProjectItemID, "type": job.Kind, "state": job.State, "createdAt": job.CreatedAt, "updatedAt": job.UpdatedAt}
	if job.ResultJSON.Valid {
		var value any
		if json.Unmarshal([]byte(job.ResultJSON.String), &value) == nil {
			result["result"] = value
		}
	}
	if job.ErrorCode.Valid {
		result["errorCode"] = job.ErrorCode.String
	}
	return result
}

// ExportDownloadHandler streams an owned export after rechecking the bearer
// credential, permission, and current resource scope. It deliberately does not
// use a URL token, so revocation takes effect before every artifact download.
func ExportDownloadHandler(config TransportConfig, proposals *ProposalService, jobs interface {
	Get(context.Context, string) (jobqueue.Job, error)
	Cancel(context.Context, string) (jobqueue.Job, error)
}, downloads projects.ExportDownloadService) (http.Handler, error) {
	if proposals == nil || jobs == nil || downloads == nil {
		return nil, errors.New("mcp download dependencies are required")
	}
	handler, err := NewTransport(config)
	if err != nil {
		return nil, err
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		transport := handler.(*transport)
		if !transport.enabled() {
			http.NotFound(w, r)
			return
		}
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", http.MethodGet)
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if !transport.validTransport(r, transport.requestInfo(r)) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		token, ok := bearerToken(r.Header.Values("Authorization"))
		if !ok {
			unauthorized(w)
			return
		}
		credential, err := config.Credentials.Authenticate(r.Context(), token)
		if err != nil {
			unauthorized(w)
			return
		}
		parts := strings.Split(strings.TrimPrefix(r.URL.Path, exportDownloadPath), "/")
		if len(parts) != 2 || !strings.HasPrefix(parts[0], "j_") || !validSafeIdentifier(parts[0]) {
			http.NotFound(w, r)
			return
		}
		position, err := strconv.Atoi(parts[1])
		if err != nil || position < 0 || position > 99 {
			http.NotFound(w, r)
			return
		}
		raw := json.RawMessage(`{"jobId":` + strconv.Quote(parts[0]) + `,"position":` + strconv.Itoa(position) + `}`)
		job, err := authorizeOwnedJob(Context{Request: r, Credential: credential}, proposals, jobs, raw, PermissionExportsDownload, true)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		file, name, err := downloads.Download(r.Context(), job.ID, position)
		if err != nil || !safeDownloadName(name) {
			http.NotFound(w, r)
			return
		}
		defer file.Close()
		w.Header().Set("Content-Type", exportpolicy.MIMEForOutputName(name))
		w.Header().Set("Content-Disposition", `attachment; filename="`+name+`"`)
		_, _ = io.Copy(w, file)
	}), nil
}

func safeDownloadName(name string) bool {
	if name == "" || len(name) > 255 || strings.ContainsAny(name, `/\\"`) || strings.Contains(name, "..") {
		return false
	}
	for _, character := range name {
		if character < 32 || character == 127 {
			return false
		}
	}
	return true
}

func toolData(text string, value any) ToolResult {
	data, _ := json.Marshal(value)
	var structured map[string]any
	_ = json.Unmarshal(data, &structured)
	return ToolResult{Content: []ToolContent{{Type: "text", Text: text}}, StructuredContent: structured}
}

func proposeExportSchema() map[string]any {
	return map[string]any{"type": "object", "additionalProperties": false, "required": []string{"export"}, "properties": map[string]any{"projectId": map[string]any{"type": "string"}, "projectRevision": map[string]any{"type": "integer", "minimum": 1}, "mediaId": map[string]any{"type": "string"}, "ranges": map[string]any{"type": "array", "items": map[string]any{"type": "object"}}, "export": map[string]any{"type": "object"}}}
}
func proposalIDSchema() map[string]any {
	return map[string]any{"type": "object", "additionalProperties": false, "required": []string{"proposalId"}, "properties": map[string]any{"proposalId": map[string]any{"type": "string"}}}
}
func jobIDSchema() map[string]any {
	return map[string]any{"type": "object", "additionalProperties": false, "required": []string{"jobId"}, "properties": map[string]any{"jobId": map[string]any{"type": "string"}}}
}
func downloadSchema() map[string]any {
	return map[string]any{"type": "object", "additionalProperties": false, "required": []string{"jobId", "position"}, "properties": map[string]any{"jobId": map[string]any{"type": "string"}, "position": map[string]any{"type": "integer", "minimum": 0, "maximum": 99}}}
}
