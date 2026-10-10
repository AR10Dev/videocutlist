// Package testsupport contains constructors shared by tests across packages.
package testsupport

import (
	"database/sql"

	dbstore "videocutlist/internal/db"
	"videocutlist/internal/jobs"
)

// NewJobsStore constructs a durable job store backed by the test database.
func NewJobsStore(database *sql.DB) (*jobs.JobsStore, error) {
	storage, err := dbstore.NewJobStorage(database)
	if err != nil {
		return nil, err
	}
	return jobs.NewJobsStore(storage)
}
