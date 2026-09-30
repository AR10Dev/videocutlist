package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"strings"
	"unicode"
	"unicode/utf8"

	"videocutlist/internal/projects"
)

const (
	mediaPageDefault = 20
	mediaPageLimit   = 50
	mediaScanLimit   = 500
)

// MediaReader is the safe media read surface used by the MCP media tools.
type MediaReader interface {
	List(ctx context.Context, cursor string, limit int) (projects.MediaPage, error)
	Get(ctx context.Context, id string) (projects.Media, error)
}

// MediaTools provides the bounded, path-free media read tools.
func MediaTools(media MediaReader) []Tool {
	return []Tool{
		{
			Name:        "list_media",
			Description: "List authorized media by opaque ID, optionally filtered by name.",
			Permission:  PermissionMediaRead,
			InputSchema: mediaListSchema(),
			Resource: func(Context, json.RawMessage) (Resource, error) {
				return Resource{}, nil
			},
			Call: func(ctx Context, raw json.RawMessage) (ToolResult, error) {
				return listMedia(ctx, media, raw)
			},
		},
		{
			Name:        "get_media",
			Description: "Get safe metadata for one authorized opaque media ID.",
			Permission:  PermissionMediaRead,
			InputSchema: mediaGetSchema(),
			Resource: func(ctx Context, raw json.RawMessage) (Resource, error) {
				id, err := mediaIDArgument(raw)
				if err != nil {
					return Resource{}, err
				}
				item, err := media.Get(ctx.Request.Context(), id)
				if err != nil {
					return Resource{}, err
				}
				return Resource{MediaID: item.ID, RootID: item.RootID}, nil
			},
			Call: func(ctx Context, raw json.RawMessage) (ToolResult, error) {
				id, err := mediaIDArgument(raw)
				if err != nil {
					return ToolResult{}, err
				}
				item, err := media.Get(ctx.Request.Context(), id)
				if err != nil {
					return ToolResult{}, err
				}
				return mediaResult(item), nil
			},
		},
	}
}

func listMedia(ctx Context, media MediaReader, raw json.RawMessage) (ToolResult, error) {
	args := struct {
		Cursor *string `json:"cursor"`
		Limit  *int    `json:"limit"`
		Query  *string `json:"query"`
	}{Cursor: new(""), Limit: new(mediaPageDefault), Query: new("")}
	// Defaults survive omitted fields; explicit null clears the pointers.
	if err := decodeToolArguments(raw, &args); err != nil || args.Cursor == nil || args.Limit == nil || args.Query == nil {
		return ToolResult{}, ErrInvalidInput
	}
	limit := *args.Limit
	if !validMediaCursor(*args.Cursor) || !validMediaQuery(*args.Query) || limit < 1 || limit > mediaPageLimit {
		return ToolResult{}, ErrInvalidInput
	}

	items := make([]map[string]any, 0, limit)
	cursor := *args.Cursor
	query := strings.ToLower(*args.Query)
	for scanned := 0; scanned < mediaScanLimit && len(items) < limit; {
		batch := min(mediaPageLimit, mediaScanLimit-scanned)
		page, err := media.List(ctx.Request.Context(), cursor, batch)
		if err != nil {
			return ToolResult{}, err
		}
		pageComplete := true
		for position, item := range page.Items {
			scanned++
			cursor = item.ID
			if ctx.Credential.AllowsMedia(item.ID, item.RootID) && strings.Contains(strings.ToLower(item.Name), query) {
				items = append(items, safeMedia(item))
				if len(items) == limit {
					pageComplete = position == len(page.Items)-1
					break
				}
			}
		}
		if len(items) == limit {
			if pageComplete {
				if page.NextCursor == nil {
					cursor = ""
				} else {
					cursor = *page.NextCursor
				}
			}
			break
		}
		if page.NextCursor == nil || len(page.Items) == 0 {
			cursor = ""
			break
		}
		cursor = *page.NextCursor
	}
	result := map[string]any{"items": items}
	if cursor != "" {
		result["nextCursor"] = cursor
	}
	return ToolResult{Content: []ToolContent{{Type: "text", Text: "Media listed."}}, StructuredContent: result}, nil
}

func mediaResult(item projects.Media) ToolResult {
	return ToolResult{Content: []ToolContent{{Type: "text", Text: "Media retrieved."}}, StructuredContent: safeMedia(item)}
}

func safeMedia(item projects.Media) map[string]any {
	return map[string]any{
		"id":         item.ID,
		"name":       item.Name,
		"durationMs": item.DurationMS,
		"sizeBytes":  item.SizeBytes,
		"container":  item.Container,
		"streams":    item.Streams,
	}
}

func mediaIDArgument(raw json.RawMessage) (string, error) {
	var args struct {
		ID string `json:"id"`
	}
	if err := decodeToolArguments(raw, &args); err != nil || args.ID == "" || !validMediaCursor(args.ID) {
		return "", ErrInvalidInput
	}
	return args.ID, nil
}

func decodeToolArguments(raw json.RawMessage, value any) error {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return ErrInvalidInput
	}
	decoder := json.NewDecoder(bytes.NewReader(trimmed))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil || decoder.Decode(new(any)) != io.EOF {
		return ErrInvalidInput
	}
	return nil
}

func validMediaCursor(value string) bool {
	return value == "" || strings.HasPrefix(value, "m_") && validSafeIdentifier(value)
}

func validMediaQuery(value string) bool {
	return utf8.ValidString(value) && utf8.RuneCountInString(value) <= 120 && strings.IndexFunc(value, unicode.IsControl) < 0
}

func mediaListSchema() map[string]any {
	return map[string]any{"type": "object", "additionalProperties": false, "properties": map[string]any{
		"cursor": map[string]any{"type": "string"}, "limit": map[string]any{"type": "integer", "minimum": 1, "maximum": mediaPageLimit}, "query": map[string]any{"type": "string", "maxLength": 120},
	}}
}

func mediaGetSchema() map[string]any {
	return map[string]any{"type": "object", "additionalProperties": false, "required": []string{"id"}, "properties": map[string]any{"id": map[string]any{"type": "string"}}}
}
