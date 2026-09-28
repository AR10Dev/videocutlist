package mcp

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"

	"videocutlist/internal/projects"
	"videocutlist/internal/projects/model"
)

const maxPreviewBase64Bytes = 512 << 10

// PreviewDetectionTools exposes bounded, scoped preview generation and detection.
func PreviewDetectionTools(media MediaReader, preview interface {
	Start(context.Context, projects.PreviewSpec) (projects.PreviewResult, error)
}, detection interface {
	Create(context.Context, string, projects.DetectionRequest) (projects.DetectionJob, error)
}, project projects.ProjectService) []Tool {
	if media == nil || preview == nil || detection == nil || project == nil {
		return nil
	}
	return []Tool{
		{Name: "create_preview", Description: "Create a bounded MP4 preview for authorized media.", Permission: PermissionPreviewsCreate, InputSchema: previewSchema(), Resource: func(ctx Context, raw json.RawMessage) (Resource, error) {
			item, err := previewMedia(ctx, media, raw)
			return Resource{MediaID: item.ID, RootID: item.RootID}, err
		}, Call: func(ctx Context, raw json.RawMessage) (ToolResult, error) {
			args, err := previewArguments(raw)
			if err != nil {
				return ToolResult{}, err
			}
			item, err := media.Get(ctx.Request.Context(), args.MediaID)
			if err != nil {
				return ToolResult{}, err
			}
			spec, err := projects.NormalizePreview(item.ID, item.DurationMS, args.CenterMS, args.Mute, model.WindowConfig{BeforeMS: args.BeforeMS, AfterMS: args.AfterMS, MaxMS: 15_000, GridMS: 500})
			if err != nil {
				return ToolResult{}, errors.New("invalid preview arguments")
			}
			result, err := preview.Start(ctx.Request.Context(), spec)
			if err != nil {
				return ToolResult{}, err
			}
			defer func() { _ = result.Reader.Close() }()
			data, err := io.ReadAll(io.LimitReader(result.Reader, int64(base64.StdEncoding.DecodedLen(maxPreviewBase64Bytes)+1)))
			if err != nil || base64.StdEncoding.EncodedLen(len(data)) > maxPreviewBase64Bytes {
				return ToolResult{}, errors.New("preview exceeds MCP result limit")
			}
			return toolData("Preview created.", map[string]any{"mimeType": "video/mp4", "data": base64.StdEncoding.EncodeToString(data), "startMs": result.StartMS, "durationMs": result.DurationMS, "offsetMs": result.OffsetMS}), nil
		}},
		{Name: "start_detection", Description: "Start authorized pause, black-frame, or scene-change detection and return candidates only.", Permission: PermissionDetectionRun, InputSchema: detectionSchema(), Resource: func(ctx Context, raw json.RawMessage) (Resource, error) {
			args, err := detectionArguments(raw)
			if err != nil {
				return Resource{}, err
			}
			resource, err := projectResourceByID(ctx, project, media, args.ProjectID)
			if err != nil {
				return Resource{}, err
			}
			item, err := media.Get(ctx.Request.Context(), args.MediaID)
			if err != nil {
				return Resource{}, err
			}
			resource.MediaID, resource.RootID = item.ID, item.RootID
			return resource, nil
		}, Call: func(ctx Context, raw json.RawMessage) (ToolResult, error) {
			args, err := detectionArguments(raw)
			if err != nil {
				return ToolResult{}, err
			}
			owned, err := project.Get(ctx.Request.Context(), args.ProjectID)
			if err != nil || owned.Revision != args.ProjectRevision || !projectContainsMedia(owned, args.ProjectItemID, args.MediaID) {
				return ToolResult{}, errors.New("stale project")
			}
			job, err := detection.Create(ctx.Request.Context(), args.ProjectID, projects.DetectionRequest{MediaID: args.MediaID, ProjectItemID: args.ProjectItemID, ProjectRevision: args.ProjectRevision, Kind: args.Kind, NoiseDB: args.NoiseDB, MinDurationMS: args.MinDurationMS, SceneThreshold: args.SceneThreshold, CredentialID: ctx.Credential.ID})
			if err != nil {
				return ToolResult{}, err
			}
			return toolData("Detection started.", job), nil
		}},
	}
}

type previewArgs struct {
	MediaID  string `json:"mediaId"`
	CenterMS int64  `json:"centerMs"`
	BeforeMS int64  `json:"beforeMs"`
	AfterMS  int64  `json:"afterMs"`
	Mute     bool   `json:"mute"`
}

func previewArguments(raw json.RawMessage) (previewArgs, error) {
	var args previewArgs
	if err := decodeToolArguments(raw, &args); err != nil || !validMediaCursor(args.MediaID) || args.CenterMS < 0 || args.BeforeMS < 0 || args.AfterMS < 0 || args.BeforeMS+args.AfterMS < 1 || args.BeforeMS+args.AfterMS > 15_000 {
		return previewArgs{}, errors.New("invalid preview arguments")
	}
	return args, nil
}

func previewMedia(ctx Context, media MediaReader, raw json.RawMessage) (projects.Media, error) {
	args, err := previewArguments(raw)
	if err != nil {
		return projects.Media{}, err
	}
	return media.Get(ctx.Request.Context(), args.MediaID)
}

type detectionArgs struct {
	ProjectID       string              `json:"projectId"`
	ProjectItemID   string              `json:"projectItemId"`
	MediaID         string              `json:"mediaId"`
	ProjectRevision int64               `json:"projectRevision"`
	Kind            model.DetectionKind `json:"kind"`
	NoiseDB         float64             `json:"noiseDb"`
	MinDurationMS   int64               `json:"minDurationMs"`
	SceneThreshold  float64             `json:"sceneThreshold"`
}

func detectionArguments(raw json.RawMessage) (detectionArgs, error) {
	var args detectionArgs
	if err := decodeToolArguments(raw, &args); err != nil || !validProjectID(args.ProjectID) || !validSafeIdentifier(args.ProjectItemID) || !validMediaCursor(args.MediaID) || args.ProjectRevision < 1 || projects.ValidateDetectionRequest(projects.DetectionRequest{MediaID: args.MediaID, ProjectRevision: args.ProjectRevision, Kind: args.Kind, NoiseDB: args.NoiseDB, MinDurationMS: args.MinDurationMS, SceneThreshold: args.SceneThreshold}) != nil {
		return detectionArgs{}, errors.New("invalid detection arguments")
	}
	return args, nil
}

func projectContainsMedia(project projects.Project, itemID, mediaID string) bool {
	for _, item := range project.Items {
		if item.ID == itemID && item.MediaID == mediaID {
			return true
		}
	}
	return false
}

func previewSchema() map[string]any {
	return map[string]any{"type": "object", "additionalProperties": false, "required": []string{"mediaId", "centerMs", "beforeMs", "afterMs", "mute"}, "properties": map[string]any{"mediaId": map[string]any{"type": "string"}, "centerMs": map[string]any{"type": "integer", "minimum": 0}, "beforeMs": map[string]any{"type": "integer", "minimum": 0, "maximum": 15000}, "afterMs": map[string]any{"type": "integer", "minimum": 0, "maximum": 15000}, "mute": map[string]any{"type": "boolean"}}}
}

func detectionSchema() map[string]any {
	return map[string]any{"type": "object", "additionalProperties": false, "required": []string{"projectId", "projectItemId", "mediaId", "projectRevision", "kind"}, "properties": map[string]any{"projectId": map[string]any{"type": "string"}, "projectItemId": map[string]any{"type": "string"}, "mediaId": map[string]any{"type": "string"}, "projectRevision": map[string]any{"type": "integer", "minimum": 1}, "kind": map[string]any{"type": "string", "enum": []string{"silence", "black", "scene"}}, "noiseDb": map[string]any{"type": "number", "minimum": -100, "maximum": 0}, "minDurationMs": map[string]any{"type": "integer", "minimum": 0, "maximum": 86400000}, "sceneThreshold": map[string]any{"type": "number", "minimum": 0, "maximum": 1}}}
}
