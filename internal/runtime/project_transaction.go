package runtime

import (
	"context"
	"database/sql"
	"encoding/json"

	"videocutlist/internal/projects"
	"videocutlist/internal/projects/model"
)

// SaveTx persists a project mutation using the caller's transaction. It keeps
// project serialization at the runtime adapter boundary while allowing an
// outer operation to commit project and authorization changes together.
func (p ProjectRepository) SaveTx(ctx context.Context, tx *sql.Tx, id string, revision int64, document model.Document) (projects.ProjectRecord, error) {
	data, err := json.Marshal(document)
	if err != nil {
		return projects.ProjectRecord{}, err
	}
	record, err := p.Store.SaveTx(ctx, tx, id, revision, string(data))
	if err != nil {
		return projects.ProjectRecord{}, err
	}
	return project(record)
}
