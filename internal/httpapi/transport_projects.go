package httpapi

import (
	"fmt"
	"net/http"

	"github.com/oapi-codegen/nullable"
	"videocutlist/internal/httpapi/transport"
	"videocutlist/internal/projects"
	"videocutlist/internal/projects/model"
)

func writeProjectPageJSON(writer http.ResponseWriter, requestID string, page projects.ProjectPage) {
	mapped := transport.ProjectPage{Items: mapProjectSummaries(page.Items)}
	if page.NextCursor == nil {
		mapped.NextCursor = nullable.NewNullNullable[string]()
	} else {
		mapped.NextCursor = nullable.NewNullableWithValue(*page.NextCursor)
	}
	for i, summary := range page.Items {
		revision, ok := projectRevisionToTransport(summary.Revision)
		if !ok {
			internalError(writer, requestID, fmt.Errorf("project revision exceeds transport integer range"))
			return
		}
		mapped.Items[i].Revision = revision
	}
	httpx.WriteJSON(writer, http.StatusOK, mapped)
}

func mapProjectSummaries(items []projects.ProjectSummary) []transport.ProjectSummary {
	if items == nil {
		return nil
	}
	mapped := make([]transport.ProjectSummary, len(items))
	for i, item := range items {
		mapped[i] = transport.ProjectSummary{Id: item.ID, Name: item.Name, UpdatedAt: item.UpdatedAt}
	}
	return mapped
}

// projectItemResponse shadows only exportOptions so the legacy zero value remains omitted.
type projectItemResponse struct {
	transport.ProjectItem
	ExportOptions *transport.ProjectExportOptions `json:"exportOptions,omitempty"`
}

type projectResponse struct {
	transport.Project
	Items []projectItemResponse `json:"items"`
}

func writeProjectJSON(writer http.ResponseWriter, status int, requestID string, project projects.Project) {
	mapped, ok := projectToTransport(project)
	if !ok {
		internalError(writer, requestID, fmt.Errorf("project value exceeds transport integer range"))
		return
	}
	httpx.WriteJSON(writer, status, mapped)
}

func projectToTransport(project projects.Project) (projectResponse, bool) {
	revision, ok := projectRevisionToTransport(project.Revision)
	if !ok {
		return projectResponse{}, false
	}
	items, ok := projectItemsToTransport(project.Items)
	if !ok {
		return projectResponse{}, false
	}
	return projectResponse{
		Project: transport.Project{
			Id: project.ID, Name: project.Name, Revision: revision,
			SchemaVersion: transport.ProjectSchemaVersion(project.SchemaVersion), UpdatedAt: project.UpdatedAt,
		},
		Items: items,
	}, true
}

func projectItemsToTransport(items []model.ProjectItem) ([]projectItemResponse, bool) {
	if items == nil {
		return nil, true
	}
	mapped := make([]projectItemResponse, len(items))
	for i, item := range items {
		mappedItem, ok := projectItemToTransport(item)
		if !ok {
			return nil, false
		}
		mapped[i] = mappedItem
	}
	return mapped, true
}

func projectItemToTransport(item model.ProjectItem) (projectItemResponse, bool) {
	segments, ok := projectSegmentsToTransport(item.Segments)
	if !ok {
		return projectItemResponse{}, false
	}
	mapped := projectItemResponse{ProjectItem: transport.ProjectItem{Id: item.ID, MediaId: item.MediaID, Segments: segments}}
	if item.EditorState != nil {
		playhead, ok := projectRevisionToTransport(item.EditorState.PlayheadMS)
		if !ok {
			return projectItemResponse{}, false
		}
		mapped.EditorState = &transport.UIState{PlayheadMs: playhead, Zoom: item.EditorState.Zoom, Muted: item.EditorState.Muted}
	}
	if options := item.ExportOptions; !emptyProjectExportOptions(options) {
		mapped.ExportOptions = projectExportOptionsToTransport(options)
	}
	return mapped, true
}

func emptyProjectExportOptions(options model.ExportOptions) bool {
	return options.Mode == "" && options.Selection == "" && options.StreamIndexes == nil &&
		options.CutStrategy == "" && options.Container == "" && options.DestinationID == "" && options.FilenameTemplate == ""
}

func projectExportOptionsToTransport(options model.ExportOptions) *transport.ProjectExportOptions {
	mapped := &transport.ProjectExportOptions{}
	if options.Mode != "" {
		value := transport.ProjectExportOptionsMode(options.Mode)
		mapped.Mode = &value
	}
	if options.Selection != "" {
		value := transport.ProjectExportOptionsSelection(options.Selection)
		mapped.Selection = &value
	}
	if options.StreamIndexes != nil {
		indexes := make([]int, len(options.StreamIndexes))
		copy(indexes, options.StreamIndexes)
		mapped.StreamIndexes = &indexes
	}
	if options.CutStrategy != "" {
		value := transport.ProjectExportOptionsCutStrategy(options.CutStrategy)
		mapped.CutStrategy = &value
	}
	if options.Container != "" {
		value := transport.ProjectExportOptionsContainer(options.Container)
		mapped.Container = &value
	}
	if options.DestinationID != "" {
		mapped.DestinationId = &options.DestinationID
	}
	if options.FilenameTemplate != "" {
		mapped.FilenameTemplate = &options.FilenameTemplate
	}
	return mapped
}

func projectSegmentsToTransport(segments []model.Segment) ([]transport.Segment, bool) {
	if segments == nil {
		return nil, true
	}
	mapped := make([]transport.Segment, len(segments))
	for i, segment := range segments {
		start, ok := projectRevisionToTransport(segment.StartMS)
		if !ok {
			return nil, false
		}
		end, ok := projectRevisionToTransport(segment.EndMS)
		if !ok {
			return nil, false
		}
		included := segment.IsIncluded()
		mapped[i] = transport.Segment{StartMs: start, EndMs: end, Included: &included}
		if segment.ID != "" {
			mapped[i].Id = &segment.ID
		}
		if segment.Label != "" {
			mapped[i].Label = &segment.Label
		}
	}
	return mapped, true
}

func projectRevisionToTransport(value int64) (int, bool) {
	mapped := int(value)
	return mapped, int64(mapped) == value
}
