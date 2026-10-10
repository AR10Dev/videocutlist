package httpapi

import (
	"database/sql"
	"testing"

	"videocutlist/internal/db"
)

func newMCPTestStorage(t *testing.T, database *sql.DB) *store.MCPStorage {
	t.Helper()
	storage, err := store.NewMCPStorage(database)
	if err != nil {
		t.Fatal(err)
	}
	return storage
}
