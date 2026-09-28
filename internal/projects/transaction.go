package projects

import (
	"context"
	"database/sql"
	"errors"

	"videocutlist/internal/library/media/index"
	"videocutlist/internal/projects/model"
)

type projectTransactionRepository interface {
	ProjectRepository
	SaveTx(context.Context, *sql.Tx, string, int64, model.Document) (ProjectRecord, error)
}

type transactionProjectRepository struct {
	projectTransactionRepository
	tx *sql.Tx
}

func (r transactionProjectRepository) Save(ctx context.Context, id string, revision int64, document model.Document) (ProjectRecord, error) {
	return r.SaveTx(ctx, r.tx, id, revision, document)
}

type resolvedProjectMedia struct {
	MediaCatalog
	items map[string]Media
}

func (m resolvedProjectMedia) Get(_ context.Context, id string) (Media, error) {
	item, ok := m.items[id]
	if !ok {
		return Media{}, index.ErrNotFound
	}
	return item, nil
}

// CreateInTx validates and creates a project using media resolved before the
// caller's transaction. The transaction remains owned by the caller so project
// persistence and authorization changes commit or roll back together.
func (p ProjectUseCase) CreateInTx(ctx context.Context, tx *sql.Tx, id string, input ProjectInput, resolved []Media) (Project, error) {
	if tx == nil {
		return Project{}, errors.New("project transaction is required")
	}
	repository, ok := p.Repository.(projectTransactionRepository)
	if !ok {
		return Project{}, errors.New("transactional project repository is not configured")
	}
	items := make(map[string]Media, len(resolved))
	for _, item := range resolved {
		items[item.ID] = item
	}
	transactional := p
	transactional.Repository = transactionProjectRepository{projectTransactionRepository: repository, tx: tx}
	transactional.Media = resolvedProjectMedia{MediaCatalog: p.Media, items: items}
	return transactional.Create(ctx, id, input)
}
