package projects

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"time"

	"videocutlist/internal/db"
	exporter "videocutlist/internal/export"
	librarymedia "videocutlist/internal/library/media"
	"videocutlist/internal/library/media/index"
	"videocutlist/internal/projects/model"
	settingsmodel "videocutlist/internal/settings/model"
)

var ErrInvalidProject = errors.New("invalid project")

type ProjectRecord struct {
	Document  model.Document
	Revision  int64
	UpdatedAt time.Time
}
type ProjectRepository interface {
	Get(context.Context, string) (ProjectRecord, error)
	Save(context.Context, string, int64, model.Document) (ProjectRecord, error)
}
type ProjectListRepository interface {
	List(context.Context, string, int) ([]ProjectSummary, *string, error)
}

type ProjectItemError struct {
	ItemID string
	Code   string
}

func (e *ProjectItemError) Error() string        { return "project item " + e.ItemID + ": " + e.Code }
func (e *ProjectItemError) Is(target error) bool { return target == ErrInvalidProject }

// SelectProjectItems validates an optional item-ID selection atomically and
// returns matching items in their document order.
func SelectProjectItems(document model.Document, itemIDs []string) ([]model.ProjectItem, error) {
	if len(itemIDs) == 0 {
		return slices.Clone(document.Items), nil
	}
	known := make(map[string]struct{}, len(document.Items))
	for _, item := range document.Items {
		known[item.ID] = struct{}{}
	}
	requested := make(map[string]struct{}, len(itemIDs))
	for _, id := range itemIDs {
		if id == "" {
			return nil, &ProjectItemError{Code: "item_id_required"}
		}
		if _, duplicate := requested[id]; duplicate {
			return nil, &ProjectItemError{ItemID: id, Code: "item_id_duplicate"}
		}
		if _, exists := known[id]; !exists {
			return nil, &ProjectItemError{ItemID: id, Code: "item_id_unknown"}
		}
		requested[id] = struct{}{}
	}
	selected := make([]model.ProjectItem, 0, len(requested))
	for _, item := range document.Items {
		if _, ok := requested[item.ID]; ok {
			selected = append(selected, item)
		}
	}
	return selected, nil
}

type ExportPreflightPort interface {
	PreflightItems(context.Context, []model.ProjectItem, *model.ExportOptions) (exporter.PreflightResult, error)
}

type ExportPreflightUseCase struct{ Export ExportPreflightPort }

func (u ExportPreflightUseCase) Preflight(ctx context.Context, project Project, input ExportInput) (exporter.PreflightResult, error) {
	if u.Export == nil {
		return exporter.PreflightResult{}, errors.New("export preflight is not configured")
	}
	items, err := SelectProjectItems(project.Document, input.ItemIDs)
	if err != nil {
		return exporter.PreflightResult{}, err
	}
	for i := range items {
		items[i] = cloneProjectItem(items[i])
	}
	var override *model.ExportOptions
	if len(input.ItemIDs) == 0 && len(items) == 1 {
		override = &model.ExportOptions{
			Mode: input.Mode, Selection: input.Selection, StreamIndexes: slices.Clone(input.StreamIndexes),
			CutStrategy: input.CutStrategy, Container: input.Container,
			DestinationID: input.DestinationID, FilenameTemplate: input.FilenameTemplate,
		}
	}
	return u.Export.PreflightItems(ctx, items, override)
}

type ProjectUseCase struct {
	Repository ProjectRepository
	Media      librarymedia.MediaCatalog
}

func (p ProjectUseCase) Create(ctx context.Context, id string, input ProjectInput) (Project, error) {
	if input.Revision != 0 {
		return Project{}, store.ErrRevisionConflict
	}
	return p.Save(ctx, id, input)
}

func (p ProjectUseCase) List(ctx context.Context, cursor string, limit int) (ProjectPage, error) {
	repository, ok := p.Repository.(ProjectListRepository)
	if !ok {
		return ProjectPage{}, errors.New("project listing is not configured")
	}
	items, next, err := repository.List(ctx, cursor, limit)
	if err != nil {
		return ProjectPage{}, err
	}
	return ProjectPage{Items: items, NextCursor: next}, nil
}

func (p ProjectUseCase) Get(ctx context.Context, id string) (Project, error) {
	record, err := p.Repository.Get(ctx, id)
	if err != nil {
		return Project{}, err
	}
	document := record.Document
	model.EnsureSegmentIDs(&document)
	return Project{ID: id, Document: document, Revision: record.Revision, UpdatedAt: record.UpdatedAt}, nil
}

// PrepareCreate validates a new project against media already resolved by the
// caller, before any transaction that combines project and authorization writes.
func (p ProjectUseCase) PrepareCreate(ctx context.Context, id string, input ProjectInput, resolved []librarymedia.Media) (PreparedProject, error) {
	if input.Revision != 0 {
		return PreparedProject{}, store.ErrRevisionConflict
	}
	mediaByID := make(map[string]librarymedia.Media, len(resolved))
	for _, item := range resolved {
		mediaByID[item.ID] = item
	}
	document, err := prepareProjectDocument(ctx, input, preloadedProjectMedia{items: mediaByID})
	if err != nil {
		return PreparedProject{}, err
	}
	documentJSON, err := encodeProjectDocument(document)
	if err != nil {
		return PreparedProject{}, err
	}
	return PreparedProject{Project: Project{ID: id, Document: document}, DocumentJSON: documentJSON}, nil
}

func (p ProjectUseCase) Save(ctx context.Context, id string, input ProjectInput) (Project, error) {
	if p.Media == nil {
		return Project{}, errors.New("project media catalog is required")
	}
	document, err := prepareProjectDocument(ctx, input, p.Media)
	if err != nil {
		return Project{}, err
	}
	record, err := p.Repository.Save(ctx, id, input.Revision, document)
	if err != nil {
		return Project{}, err
	}
	return Project{ID: id, Document: record.Document, Revision: record.Revision, UpdatedAt: record.UpdatedAt}, nil
}

type projectMediaReader interface {
	Get(context.Context, string) (librarymedia.Media, error)
}

type preloadedProjectMedia struct {
	items map[string]librarymedia.Media
}

func (m preloadedProjectMedia) Get(_ context.Context, id string) (librarymedia.Media, error) {
	item, ok := m.items[id]
	if !ok {
		return librarymedia.Media{}, index.ErrNotFound
	}
	return item, nil
}

func prepareProjectDocument(ctx context.Context, input ProjectInput, media projectMediaReader) (model.Document, error) {
	if input.Revision < 0 {
		return model.Document{}, ErrInvalidProject
	}
	if err := model.ValidateProject(input.Document); err != nil {
		return model.Document{}, fmt.Errorf("%w: %w", ErrInvalidProject, err)
	}
	for _, item := range input.Items {
		resolved, err := media.Get(ctx, item.MediaID)
		if errors.Is(err, index.ErrNotFound) {
			return model.Document{}, &ProjectItemError{ItemID: item.ID, Code: "media_unavailable"}
		}
		if err != nil {
			return model.Document{}, fmt.Errorf("get project media: %w", err)
		}
		if err := model.ValidateProjectItem(item, resolved.DurationMS); err != nil {
			return model.Document{}, &ProjectItemError{ItemID: item.ID, Code: "invalid"}
		}
	}
	return input.Document, nil
}

func runtimeSettings(state *settingsmodel.RuntimeSettingsState) *settingsmodel.RuntimeSettings {
	if state == nil {
		return nil
	}
	settings := state.Snapshot()
	return &settings
}
