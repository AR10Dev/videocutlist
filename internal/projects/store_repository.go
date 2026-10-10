package projects

import (
	"context"
	"encoding/json"

	store "videocutlist/internal/db"
	"videocutlist/internal/projects/model"
)

// StoreRepository adapts persisted documents to the project-owned interface.
type StoreRepository struct{ Store *store.ProjectStore }

func (p StoreRepository) List(ctx context.Context, cursor string, limit int) ([]ProjectSummary, *string, error) {
	items, next, err := p.Store.List(ctx, cursor, limit)
	if err != nil {
		return nil, nil, err
	}
	summaries := make([]ProjectSummary, len(items))
	for i, item := range items {
		summaries[i] = ProjectSummary{ID: item.ID, Name: item.Name, Revision: item.Revision, UpdatedAt: item.UpdatedAt}
	}
	return summaries, next, nil
}
func (p StoreRepository) Get(ctx context.Context, id string) (ProjectRecord, error) {
	record, err := p.Store.Get(ctx, id)
	if err != nil {
		return ProjectRecord{}, err
	}
	return decodeProjectRecord(record)
}
func (p StoreRepository) Save(ctx context.Context, id string, revision int64, document model.Document) (ProjectRecord, error) {
	documentJSON, err := encodeProjectDocument(document)
	if err != nil {
		return ProjectRecord{}, err
	}
	record, err := p.Store.Save(ctx, id, revision, documentJSON)
	if err != nil {
		return ProjectRecord{}, err
	}
	return decodeProjectRecord(record)
}

func encodeProjectDocument(document model.Document) (string, error) {
	data, err := json.Marshal(document)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

func decodeProjectRecord(record store.ProjectRecord) (ProjectRecord, error) {
	var document model.Document
	if err := json.Unmarshal([]byte(record.DocumentJSON), &document); err != nil {
		return ProjectRecord{}, err
	}
	return ProjectRecord{Document: document, Revision: record.Revision, UpdatedAt: record.UpdatedAt}, nil
}
