package mcp_test

import (
	"fmt"
	"testing"
	"time"
	"videocutlist/internal/mcp"
)

func TestProjectGrantCapacityPreservesCredential(t *testing.T) {
	_, credentials, clock := newCredentialStore(t)
	ids := make([]string, 1000)
	for i := range ids {
		ids[i] = fmt.Sprintf("p_capacity%04d", i)
	}
	expires := clock.Add(time.Hour)
	created, err := credentials.Create(t.Context(), mcp.CredentialInput{Name: "capacity", MediaScope: mcp.MediaScope{Kind: mcp.MediaScopeAll}, ProjectScope: mcp.ProjectScope{Kind: mcp.ProjectScopeSelected, ProjectIDs: ids}, ExpiresAt: &expires})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = credentials.GrantProject(t.Context(), created.ID, "p_capacityoverflow"); err == nil {
		t.Fatal("over-capacity grant accepted")
	}
	authenticated, err := credentials.Authenticate(t.Context(), created.Secret)
	if err != nil {
		t.Fatalf("capacity error corrupted credential: %v", err)
	}
	if len(authenticated.ProjectScope.ProjectIDs) != 1000 || authenticated.AllowsProjectSummary("p_capacityoverflow") {
		t.Fatal("rejected grant mutated scope")
	}
	if _, err = credentials.GrantProject(t.Context(), created.ID, ids[0]); err != nil {
		t.Fatalf("existing grant not idempotent at capacity: %v", err)
	}
}
