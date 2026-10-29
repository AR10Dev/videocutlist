package projects

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"unicode/utf8"

	"videocutlist/internal/projects/model"
)

const MaxProjectImportBytes = 1 << 20

var (
	ErrInvalidProjectImport  = errors.New("invalid project import")
	ErrProjectImportTooLarge = errors.New("project import exceeds limit")
)

type ProjectImportResult struct {
	SourceFormat string
	MediaID      string
	Document     model.Document
}

// Import validates and converts project JSON without calling the repository.
func (p ProjectUseCase) Import(ctx context.Context, content []byte) (ProjectImportResult, error) {
	if len(content) > MaxProjectImportBytes {
		return ProjectImportResult{}, ErrProjectImportTooLarge
	}
	if p.Media == nil {
		return ProjectImportResult{}, errors.New("project media catalog is required")
	}
	document, sourceFormat, mediaID, err := parseProjectImport(content)
	if err != nil {
		return ProjectImportResult{}, err
	}
	validated, err := prepareProjectDocument(ctx, ProjectInput{Document: document}, p.Media)
	if err != nil {
		return ProjectImportResult{}, err
	}
	return ProjectImportResult{SourceFormat: sourceFormat, MediaID: mediaID, Document: validated}, nil
}

func parseProjectImport(content []byte) (model.Document, string, string, error) {
	if !utf8.Valid(content) {
		return model.Document{}, "", "", ErrInvalidProjectImport
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(content, &fields); err != nil || fields == nil {
		return model.Document{}, "", "", ErrInvalidProjectImport
	}
	var schemaVersion float64
	if json.Unmarshal(fields["schemaVersion"], &schemaVersion) == nil && schemaVersion == model.ProjectSchemaVersion {
		document, err := parseV2ProjectImport(fields)
		return document, "v2", "", err
	}
	document, mediaID, err := parseLegacyProjectImport(fields)
	return document, "legacy", mediaID, err
}

func parseV2ProjectImport(fields map[string]json.RawMessage) (model.Document, error) {
	if !hasJSONFields(fields, "schemaVersion", "name", "items") {
		return model.Document{}, ErrInvalidProjectImport
	}
	name, ok := parseProjectImportString(fields["name"])
	if !ok || strings.TrimSpace(name) == "" || utf8.RuneCountInString(name) > 120 {
		return model.Document{}, ErrInvalidProjectImport
	}
	var rawItems []json.RawMessage
	if err := json.Unmarshal(fields["items"], &rawItems); err != nil || rawItems == nil || len(rawItems) == 0 {
		return model.Document{}, ErrInvalidProjectImport
	}
	items := make([]model.ProjectItem, len(rawItems))
	for i, rawItem := range rawItems {
		itemFields, ok := parseProjectImportObject(rawItem)
		if !ok || !hasJSONFields(itemFields, "id", "mediaId", "segments") {
			return model.Document{}, ErrInvalidProjectImport
		}
		id, idOK := parseProjectImportString(itemFields["id"])
		mediaID, mediaIDOK := parseProjectImportString(itemFields["mediaId"])
		segments, segmentsErr := parseProjectImportSegments(itemFields["segments"])
		if !idOK || !mediaIDOK || segmentsErr != nil {
			return model.Document{}, ErrInvalidProjectImport
		}
		item := model.ProjectItem{ID: id, MediaID: mediaID, Segments: segments}
		if editorState, exists := itemFields["editorState"]; exists {
			parsed, ok := parseProjectImportEditorState(editorState)
			if !ok {
				return model.Document{}, ErrInvalidProjectImport
			}
			item.EditorState = parsed
		}
		if exportOptions, exists := itemFields["exportOptions"]; exists {
			parsed, ok := parseProjectImportExportOptions(exportOptions)
			if !ok {
				return model.Document{}, ErrInvalidProjectImport
			}
			item.ExportOptions = parsed
		}
		item.ExportOptions = item.ExportOptions.WithExportDefaults()
		items[i] = item
	}
	return model.Document{SchemaVersion: model.ProjectSchemaVersion, Name: name, Items: items}, nil
}

func parseLegacyProjectImport(fields map[string]json.RawMessage) (model.Document, string, error) {
	if !hasJSONFields(fields, "mediaId", "segments", "uiState") {
		return model.Document{}, "", ErrInvalidProjectImport
	}
	mediaID, ok := parseProjectImportString(fields["mediaId"])
	if !ok {
		return model.Document{}, "", ErrInvalidProjectImport
	}
	if _, ok := parseProjectImportObject(fields["uiState"]); !ok {
		return model.Document{}, "", ErrInvalidProjectImport
	}
	segments, err := parseProjectImportSegments(fields["segments"])
	if err != nil {
		return model.Document{}, "", err
	}
	var randomID [18]byte
	if _, err := rand.Read(randomID[:]); err != nil {
		return model.Document{}, "", fmt.Errorf("generate project item ID: %w", err)
	}
	item := model.ProjectItem{
		ID:            "i_" + base64.RawURLEncoding.EncodeToString(randomID[:]),
		MediaID:       mediaID,
		Segments:      segments,
		ExportOptions: (model.ExportOptions{}).WithExportDefaults(),
	}
	document := model.Document{
		SchemaVersion: model.ProjectSchemaVersion,
		Name:          "Imported cut list",
		Items:         []model.ProjectItem{item},
	}
	return document, mediaID, nil
}

func parseProjectImportSegments(value json.RawMessage) ([]model.Segment, error) {
	var rawSegments []json.RawMessage
	if err := json.Unmarshal(value, &rawSegments); err != nil || rawSegments == nil {
		return nil, ErrInvalidProjectImport
	}
	segments := make([]model.Segment, len(rawSegments))
	for i, rawSegment := range rawSegments {
		fields, ok := parseProjectImportObject(rawSegment)
		if !ok || !hasJSONFields(fields, "startMs", "endMs") {
			return nil, ErrInvalidProjectImport
		}
		startMS, startOK := parseProjectImportInteger(fields["startMs"], 64)
		endMS, endOK := parseProjectImportInteger(fields["endMs"], 64)
		id, idOK := parseProjectImportOptionalString(fields, "id")
		label, labelOK := parseProjectImportOptionalString(fields, "label")
		if !startOK || !endOK || !idOK || !labelOK {
			return nil, ErrInvalidProjectImport
		}
		segment := model.Segment{ID: id, StartMS: startMS, EndMS: endMS, Label: label, Included: true}
		if included, exists := fields["included"]; exists {
			value, ok := parseProjectImportBoolean(included)
			if !ok {
				return nil, ErrInvalidProjectImport
			}
			segment = segment.WithIncluded(value)
		}
		segments[i] = segment
	}
	return segments, nil
}

func parseProjectImportEditorState(value json.RawMessage) (*model.UIState, bool) {
	fields, ok := parseProjectImportObject(value)
	if !ok || !hasJSONFields(fields, "playheadMs", "zoom", "muted") {
		return nil, false
	}
	playheadMS, ok := parseProjectImportInteger(fields["playheadMs"], 64)
	if !ok || isJSONNull(fields["zoom"]) || isJSONNull(fields["muted"]) {
		return nil, false
	}
	var zoom float64
	if json.Unmarshal(fields["zoom"], &zoom) != nil {
		return nil, false
	}
	muted, ok := parseProjectImportBoolean(fields["muted"])
	if !ok {
		return nil, false
	}
	return &model.UIState{PlayheadMS: playheadMS, Zoom: zoom, Muted: muted}, true
}

func parseProjectImportExportOptions(value json.RawMessage) (model.ExportOptions, bool) {
	fields, ok := parseProjectImportObject(value)
	if !ok {
		return model.ExportOptions{}, false
	}
	mode, modeOK := parseProjectImportOptionalString(fields, "mode")
	selection, selectionOK := parseProjectImportOptionalString(fields, "selection")
	cutStrategy, cutStrategyOK := parseProjectImportOptionalString(fields, "cutStrategy")
	container, containerOK := parseProjectImportOptionalString(fields, "container")
	destinationID, destinationOK := parseProjectImportOptionalString(fields, "destinationId")
	filenameTemplate, filenameOK := parseProjectImportOptionalString(fields, "filenameTemplate")
	if !modeOK || !selectionOK || !cutStrategyOK || !containerOK || !destinationOK || !filenameOK {
		return model.ExportOptions{}, false
	}
	options := model.ExportOptions{
		Mode:             mode,
		Selection:        selection,
		CutStrategy:      cutStrategy,
		Container:        container,
		DestinationID:    destinationID,
		FilenameTemplate: filenameTemplate,
	}
	if rawIndexes, exists := fields["streamIndexes"]; exists {
		var indexes []json.RawMessage
		if isJSONNull(rawIndexes) || json.Unmarshal(rawIndexes, &indexes) != nil || indexes == nil {
			return model.ExportOptions{}, false
		}
		options.StreamIndexes = make([]int, len(indexes))
		for i, rawIndex := range indexes {
			index, ok := parseProjectImportInteger(rawIndex, strconv.IntSize)
			if !ok || index < 0 {
				return model.ExportOptions{}, false
			}
			options.StreamIndexes[i] = int(index)
		}
	}
	return options, true
}

func parseProjectImportObject(value json.RawMessage) (map[string]json.RawMessage, bool) {
	var fields map[string]json.RawMessage
	if json.Unmarshal(value, &fields) != nil || fields == nil {
		return nil, false
	}
	return fields, true
}

func parseProjectImportString(value json.RawMessage) (string, bool) {
	if isJSONNull(value) {
		return "", false
	}
	var parsed string
	if json.Unmarshal(value, &parsed) != nil {
		return "", false
	}
	return parsed, true
}

func parseProjectImportOptionalString(fields map[string]json.RawMessage, name string) (string, bool) {
	value, exists := fields[name]
	if !exists {
		return "", true
	}
	return parseProjectImportString(value)
}

func parseProjectImportBoolean(value json.RawMessage) (bool, bool) {
	if isJSONNull(value) {
		return false, false
	}
	var parsed bool
	if json.Unmarshal(value, &parsed) != nil {
		return false, false
	}
	return parsed, true
}

func parseProjectImportInteger(value json.RawMessage, bitSize int) (int64, bool) {
	text := strings.TrimSpace(string(value))
	if text == "" || (text[0] != '-' && (text[0] < '0' || text[0] > '9')) {
		return 0, false
	}
	parsed, err := strconv.ParseInt(text, 10, bitSize)
	return parsed, err == nil
}

func isJSONNull(value json.RawMessage) bool { return strings.TrimSpace(string(value)) == "null" }

func hasJSONFields(fields map[string]json.RawMessage, names ...string) bool {
	if fields == nil {
		return false
	}
	for _, name := range names {
		if _, ok := fields[name]; !ok {
			return false
		}
	}
	return true
}
