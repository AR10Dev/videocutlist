package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"

	store "videocutlist/internal/db"
	"videocutlist/internal/projects"
	"videocutlist/internal/projects/model"
)

const (
	projectPageDefault = 20
	projectPageLimit   = 50
	projectScanLimit   = 500
	projectMediaLimit  = 20
	cutlistOpLimit     = 100
)

// ProjectToolService is the existing project service surface needed by the MCP
// project tools.
type ProjectToolService interface {
	projects.ProjectService
	projects.ProjectListService
}

// ProjectTools provides scoped project inspection and revision-checked cutlist edits.
func ProjectTools(projects ProjectToolService, media MediaReader, credentials *CredentialStore) []Tool {
	return []Tool{
		{
			Name: "list_projects", Description: "List authorized project summaries by opaque ID.", Permission: PermissionProjectsRead,
			InputSchema: projectListSchema(),
			Resource:    func(Context, json.RawMessage) (Resource, error) { return Resource{ProjectSummary: true}, nil },
			Call:        func(ctx Context, raw json.RawMessage) (ToolResult, error) { return listProjects(ctx, projects, raw) },
		},
		{
			Name: "get_project", Description: "Get one authorized project including its cutlist and revision.", Permission: PermissionProjectsRead,
			InputSchema: projectGetSchema(),
			Resource: func(ctx Context, raw json.RawMessage) (Resource, error) {
				return projectResource(ctx, projects, media, raw)
			},
			Call: func(ctx Context, raw json.RawMessage) (ToolResult, error) { return getProject(ctx, projects, raw) },
		},
		{
			Name: "create_project", Description: "Create a project from authorized media.", Permission: PermissionProjectsWrite,
			InputSchema: projectCreateSchema(),
			Resource: func(ctx Context, raw json.RawMessage) (Resource, error) {
				return createProjectResource(ctx, media, raw)
			},
			Call: func(ctx Context, raw json.RawMessage) (ToolResult, error) {
				return createProject(ctx, projects, media, credentials, raw)
			},
		},
		{
			Name: "update_cutlist", Description: "Apply revision-checked segment add, adjust, remove, or reorder operations.", Permission: PermissionProjectsWrite,
			InputSchema: cutlistUpdateSchema(),
			Resource: func(ctx Context, raw json.RawMessage) (Resource, error) {
				args, err := decodeCutlistArgs(raw)
				if err != nil {
					return Resource{}, err
				}
				return projectResourceByID(ctx, projects, media, args.ProjectID)
			},
			Call: func(ctx Context, raw json.RawMessage) (ToolResult, error) { return updateCutlist(ctx, projects, raw) },
		},
	}
}

func listProjects(ctx Context, service ProjectToolService, raw json.RawMessage) (ToolResult, error) {
	var args struct {
		Cursor string `json:"cursor"`
		Limit  int    `json:"limit"`
	}
	if err := decodeToolArguments(raw, &args); err != nil || !validProjectID(args.Cursor) {
		return ToolResult{}, errors.New("invalid project list arguments")
	}
	if args.Limit == 0 {
		args.Limit = projectPageDefault
	}
	if args.Limit < 1 || args.Limit > projectPageLimit {
		return ToolResult{}, errors.New("invalid project list limit")
	}
	items := make([]projects.ProjectSummary, 0, args.Limit)
	cursor := args.Cursor
	for scanned := 0; scanned < projectScanLimit && len(items) < args.Limit; {
		page, err := service.List(ctx.Request.Context(), cursor, min(projectPageLimit, projectScanLimit-scanned))
		if err != nil {
			return ToolResult{}, err
		}
		for _, project := range page.Items {
			scanned++
			cursor = project.ID
			if ctx.Credential.AllowsProjectSummary(project.ID) {
				items = append(items, project)
				if len(items) == args.Limit {
					break
				}
			}
		}
		if page.NextCursor == nil || len(items) == args.Limit || len(page.Items) == 0 {
			if page.NextCursor == nil {
				cursor = ""
			}
			break
		}
		cursor = *page.NextCursor
	}
	result := map[string]any{"items": items}
	if cursor != "" {
		result["nextCursor"] = cursor
	}
	return ToolResult{Content: []ToolContent{{Type: "text", Text: "Projects listed."}}, StructuredContent: result}, nil
}

func projectResource(ctx Context, service projects.ProjectService, media MediaReader, raw json.RawMessage) (Resource, error) {
	id, err := projectIDArgument(raw)
	if err != nil {
		return Resource{}, err
	}
	return projectResourceByID(ctx, service, media, id)
}

func projectResourceByID(ctx Context, service projects.ProjectService, media MediaReader, id string) (Resource, error) {
	project, err := service.Get(ctx.Request.Context(), id)
	if err != nil {
		return Resource{}, err
	}
	resources, err := projectMedia(ctx.Request.Context(), project, media)
	if err != nil {
		return Resource{}, err
	}
	return Resource{ProjectID: project.ID, ProjectMedia: resources}, nil
}

func getProject(ctx Context, service projects.ProjectService, raw json.RawMessage) (ToolResult, error) {
	id, err := projectIDArgument(raw)
	if err != nil {
		return ToolResult{}, err
	}
	project, err := service.Get(ctx.Request.Context(), id)
	if err != nil {
		return ToolResult{}, err
	}
	return ToolResult{Content: []ToolContent{{Type: "text", Text: "Project retrieved."}}, StructuredContent: projectResult(project)}, nil
}

func createProjectResource(ctx Context, media MediaReader, raw json.RawMessage) (Resource, error) {
	args, err := decodeCreateProjectArgs(raw)
	if err != nil {
		return Resource{}, err
	}
	resources := make([]MediaResource, 0, len(args.MediaIDs))
	for _, id := range args.MediaIDs {
		item, err := media.Get(ctx.Request.Context(), id)
		if err != nil {
			return Resource{}, err
		}
		resources = append(resources, MediaResource{ID: item.ID, RootID: item.RootID})
	}
	return Resource{ProjectMedia: resources}, nil
}

func createProject(ctx Context, service projects.ProjectService, media MediaReader, credentials *CredentialStore, raw json.RawMessage) (ToolResult, error) {
	args, err := decodeCreateProjectArgs(raw)
	if err != nil {
		return ToolResult{}, err
	}
	items := make([]model.ProjectItem, 0, len(args.MediaIDs))
	resources := make([]MediaResource, 0, len(args.MediaIDs))
	for _, mediaID := range args.MediaIDs {
		item, err := media.Get(ctx.Request.Context(), mediaID)
		if err != nil {
			return ToolResult{}, err
		}
		resources = append(resources, MediaResource{ID: item.ID, RootID: item.RootID})
		itemID, err := randomIdentifier("i_", 18)
		if err != nil {
			return ToolResult{}, err
		}
		items = append(items, model.ProjectItem{ID: itemID, MediaID: item.ID, Segments: []model.Segment{}})
	}
	if !ctx.Credential.AllowsCreateProject(resources) {
		return ToolResult{}, ErrResourceDenied
	}
	projectID, err := randomIdentifier("p_", 18)
	if err != nil {
		return ToolResult{}, err
	}
	project, err := service.Create(ctx.Request.Context(), projectID, projects.ProjectInput{Document: model.Document{SchemaVersion: model.ProjectSchemaVersion, Name: args.Name, Items: items}})
	if err != nil {
		return ToolResult{}, err
	}
	if credentials == nil {
		return ToolResult{}, errors.New("mcp credential store is required")
	}
	if _, err := credentials.GrantProject(ctx.Request.Context(), ctx.Credential.ID, project.ID); err != nil {
		return ToolResult{}, err
	}
	return ToolResult{Content: []ToolContent{{Type: "text", Text: "Project created."}}, StructuredContent: projectResult(project)}, nil
}

func updateCutlist(ctx Context, service projects.ProjectService, raw json.RawMessage) (ToolResult, error) {
	args, err := decodeCutlistArgs(raw)
	if err != nil {
		return ToolResult{}, err
	}
	project, err := service.Get(ctx.Request.Context(), args.ProjectID)
	if err != nil {
		return ToolResult{}, err
	}
	if project.Revision != args.ExpectedRevision {
		return staleRevisionResult(), nil
	}
	for _, operation := range args.Operations {
		if err := applyCutlistOperation(&project.Document, operation); err != nil {
			return ToolResult{}, err
		}
	}
	saved, err := service.Save(ctx.Request.Context(), project.ID, projects.ProjectInput{Revision: args.ExpectedRevision, Document: project.Document})
	if errors.Is(err, store.ErrRevisionConflict) {
		return staleRevisionResult(), nil
	}
	if err != nil {
		return ToolResult{}, err
	}
	return ToolResult{Content: []ToolContent{{Type: "text", Text: "Cutlist updated."}}, StructuredContent: projectResult(saved)}, nil
}

func staleRevisionResult() ToolResult {
	return ToolResult{Content: []ToolContent{{Type: "text", Text: "Stale project revision. Reload the project and retry."}}, StructuredContent: map[string]any{"error": "stale_revision"}, IsError: true}
}

type createProjectArgs struct {
	Name     string   `json:"name"`
	MediaIDs []string `json:"mediaIds"`
}

func decodeCreateProjectArgs(raw json.RawMessage) (createProjectArgs, error) {
	var args createProjectArgs
	if err := decodeToolArguments(raw, &args); err != nil || !validProjectName(args.Name) || len(args.MediaIDs) == 0 || len(args.MediaIDs) > projectMediaLimit {
		return createProjectArgs{}, errors.New("invalid project creation arguments")
	}
	seen := make(map[string]struct{}, len(args.MediaIDs))
	for _, id := range args.MediaIDs {
		if !validMediaCursor(id) {
			return createProjectArgs{}, errors.New("invalid project creation arguments")
		}
		if _, ok := seen[id]; ok {
			return createProjectArgs{}, errors.New("invalid project creation arguments")
		}
		seen[id] = struct{}{}
	}
	return args, nil
}

type cutlistArgs struct {
	ProjectID        string             `json:"projectId"`
	ExpectedRevision int64              `json:"expectedRevision"`
	Operations       []cutlistOperation `json:"operations"`
}

type cutlistOperation struct {
	Type       string        `json:"type"`
	ItemID     string        `json:"itemId"`
	SegmentID  string        `json:"segmentId"`
	Segment    model.Segment `json:"segment"`
	Position   int           `json:"position"`
	SegmentIDs []string      `json:"segmentIds"`
}

func decodeCutlistArgs(raw json.RawMessage) (cutlistArgs, error) {
	var args cutlistArgs
	if err := decodeToolArguments(raw, &args); err != nil || args.ProjectID == "" || !validProjectID(args.ProjectID) || args.ExpectedRevision < 1 || len(args.Operations) == 0 || len(args.Operations) > cutlistOpLimit {
		return cutlistArgs{}, errors.New("invalid cutlist arguments")
	}
	for _, operation := range args.Operations {
		if !validSafeIdentifier(operation.ItemID) {
			return cutlistArgs{}, errors.New("invalid cutlist arguments")
		}
		switch operation.Type {
		case "add":
			if operation.Segment.ID != "" || operation.Position < 0 || len(operation.SegmentIDs) != 0 || operation.SegmentID != "" {
				return cutlistArgs{}, errors.New("invalid cutlist arguments")
			}
		case "adjust":
			if !validSafeIdentifier(operation.SegmentID) || operation.Segment.ID != operation.SegmentID || operation.Position != 0 || len(operation.SegmentIDs) != 0 {
				return cutlistArgs{}, errors.New("invalid cutlist arguments")
			}
		case "remove":
			if !validSafeIdentifier(operation.SegmentID) || operation.Segment != (model.Segment{}) || operation.Position != 0 || len(operation.SegmentIDs) != 0 {
				return cutlistArgs{}, errors.New("invalid cutlist arguments")
			}
		case "reorder":
			if operation.Segment != (model.Segment{}) || operation.SegmentID != "" || operation.Position != 0 || len(operation.SegmentIDs) == 0 || len(operation.SegmentIDs) > cutlistOpLimit || !validSegmentIDs(operation.SegmentIDs) {
				return cutlistArgs{}, errors.New("invalid cutlist arguments")
			}
		default:
			return cutlistArgs{}, errors.New("invalid cutlist arguments")
		}
	}
	return args, nil
}

func applyCutlistOperation(document *model.Document, operation cutlistOperation) error {
	itemIndex := slices.IndexFunc(document.Items, func(item model.ProjectItem) bool { return item.ID == operation.ItemID })
	if itemIndex < 0 {
		return errors.New("project item not found")
	}
	item := &document.Items[itemIndex]
	switch operation.Type {
	case "add":
		segmentID, err := randomIdentifier("s_", 18)
		if err != nil {
			return err
		}
		operation.Segment.ID = segmentID
		if operation.Position > len(item.Segments) {
			return errors.New("segment position is out of range")
		}
		item.Segments = append(item.Segments, model.Segment{})
		copy(item.Segments[operation.Position+1:], item.Segments[operation.Position:])
		item.Segments[operation.Position] = operation.Segment
	case "adjust":
		index := slices.IndexFunc(item.Segments, func(segment model.Segment) bool { return segment.ID == operation.SegmentID })
		if index < 0 {
			return errors.New("segment not found")
		}
		item.Segments[index] = operation.Segment
	case "remove":
		index := slices.IndexFunc(item.Segments, func(segment model.Segment) bool { return segment.ID == operation.SegmentID })
		if index < 0 {
			return errors.New("segment not found")
		}
		item.Segments = append(item.Segments[:index], item.Segments[index+1:]...)
	case "reorder":
		ordered := make([]model.Segment, 0, len(item.Segments))
		for _, id := range operation.SegmentIDs {
			index := slices.IndexFunc(item.Segments, func(segment model.Segment) bool { return segment.ID == id })
			if index < 0 {
				return errors.New("segment not found")
			}
			ordered = append(ordered, item.Segments[index])
		}
		if len(ordered) != len(item.Segments) {
			return errors.New("segment reorder must include every segment")
		}
		item.Segments = ordered
	}
	return nil
}

func projectMedia(ctx context.Context, project projects.Project, media MediaReader) ([]MediaResource, error) {
	resources := make([]MediaResource, 0, len(project.Items))
	for _, item := range project.Items {
		media, err := media.Get(ctx, item.MediaID)
		if err != nil {
			return nil, err
		}
		resources = append(resources, MediaResource{ID: media.ID, RootID: media.RootID})
	}
	return resources, nil
}

func projectIDArgument(raw json.RawMessage) (string, error) {
	var args struct {
		ID        string `json:"id"`
		ProjectID string `json:"projectId"`
	}
	if err := decodeToolArguments(raw, &args); err != nil {
		return "", errors.New("invalid project ID")
	}
	id := args.ID
	if id == "" {
		id = args.ProjectID
	}
	if id == "" || !validProjectID(id) {
		return "", errors.New("invalid project ID")
	}
	return id, nil
}

func projectResult(project projects.Project) map[string]any {
	return map[string]any{"id": project.ID, "revision": project.Revision, "schemaVersion": project.SchemaVersion, "name": project.Name, "items": project.Items, "updatedAt": project.UpdatedAt}
}

func validProjectID(value string) bool {
	return value == "" || strings.HasPrefix(value, "p_") && validSafeIdentifier(value)
}

func validProjectName(value string) bool {
	return utf8.ValidString(value) && strings.TrimSpace(value) != "" && utf8.RuneCountInString(value) <= 200 && strings.IndexFunc(value, unicode.IsControl) < 0
}

func validSegmentIDs(ids []string) bool {
	seen := make(map[string]struct{}, len(ids))
	for _, id := range ids {
		if !validSafeIdentifier(id) {
			return false
		}
		if _, ok := seen[id]; ok {
			return false
		}
		seen[id] = struct{}{}
	}
	return true
}

func projectListSchema() map[string]any {
	return map[string]any{"type": "object", "additionalProperties": false, "properties": map[string]any{"cursor": map[string]any{"type": "string"}, "limit": map[string]any{"type": "integer", "minimum": 1, "maximum": projectPageLimit}}}
}

func projectGetSchema() map[string]any {
	return map[string]any{"type": "object", "additionalProperties": false, "required": []string{"id"}, "properties": map[string]any{"id": map[string]any{"type": "string"}}}
}

func projectCreateSchema() map[string]any {
	return map[string]any{"type": "object", "additionalProperties": false, "required": []string{"name", "mediaIds"}, "properties": map[string]any{"name": map[string]any{"type": "string", "maxLength": 200}, "mediaIds": map[string]any{"type": "array", "minItems": 1, "maxItems": projectMediaLimit, "items": map[string]any{"type": "string"}}}}
}

func cutlistUpdateSchema() map[string]any {
	return map[string]any{"type": "object", "additionalProperties": false, "required": []string{"projectId", "expectedRevision", "operations"}, "properties": map[string]any{
		"projectId": map[string]any{"type": "string"}, "expectedRevision": map[string]any{"type": "integer", "minimum": 1}, "operations": map[string]any{"type": "array", "minItems": 1, "maxItems": cutlistOpLimit, "items": map[string]any{"type": "object"}},
	}}
}
