package jobs

import (
	"database/sql"

	store "videocutlist/internal/db"
)

func newTestJobsStore(database *sql.DB) (*JobsStore, error) {
	storage, err := store.NewJobStorage(database)
	if err != nil {
		return nil, err
	}
	return NewJobsStore(storage)
}
