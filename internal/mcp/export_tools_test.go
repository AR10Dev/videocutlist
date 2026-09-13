package mcp

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http/httptest"
	"testing"
	"time"

	"videocutlist/internal/projects"
)

type exportToolDownload struct{}

func (exportToolDownload) Download(context.Context, string, int) (io.ReadCloser, string, error) {
	return io.NopCloser(bytes.NewReader([]byte("validated export"))), "cut.mp4", nil
}

func TestExportToolsKeepJobsOwnedAndDownloadsRevocable(t *testing.T) {
	service, _, _, _, now := newProposalTestService(t, false)
	expires := now.Add(time.Hour)
	owner, err := service.Credentials.Create(t.Context(), CredentialInput{
		Name: "export tool owner", Permissions: []Permission{PermissionExportsPrepare, PermissionExportsRun, PermissionJobsRead, PermissionJobsCancel, PermissionExportsDownload},
		MediaScope: MediaScope{Kind: MediaScopeAll}, ProjectScope: ProjectScope{Kind: ProjectScopeAll}, ExpiresAt: &expires,
	})
	if err != nil {
		t.Fatal(err)
	}
	proposal := prepareProposal(t, service, owner.ID)
	if _, err := service.Approve(t.Context(), proposal.ID); err != nil {
		t.Fatal(err)
	}
	_, created, err := service.Execute(t.Context(), proposal.ID, owner.ID)
	if err != nil || len(created) != 1 {
		t.Fatalf("execute = %#v, %v", created, err)
	}
	tools := ExportTools(service, service.Scheduler, exportToolDownload{})
	ownerContext := Context{Request: httptest.NewRequest("POST", "/mcp", nil), Credential: owner.Credential}
	getJob := toolNamed(t, tools, "get_job")
	result, err := getJob.Call(ownerContext, []byte(`{"jobId":"`+created[0].ID+`"}`))
	if err != nil || result.StructuredContent["id"] != created[0].ID {
		t.Fatalf("owned get_job = %#v, %v", result, err)
	}
	download := toolNamed(t, tools, "get_export_download")
	result, err = download.Call(ownerContext, []byte(`{"jobId":"`+created[0].ID+`","position":0}`))
	if err != nil || result.StructuredContent["name"] != "cut.mp4" || result.StructuredContent["data"] == "" {
		t.Fatalf("owned download = %#v, %v", result, err)
	}
	other, err := service.Credentials.Create(t.Context(), CredentialInput{
		Name: "other owner", Permissions: []Permission{PermissionJobsRead}, MediaScope: MediaScope{Kind: MediaScopeAll}, ProjectScope: ProjectScope{Kind: ProjectScopeAll}, ExpiresAt: &expires,
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = getJob.Call(Context{Request: ownerContext.Request, Credential: other.Credential}, []byte(`{"jobId":"`+created[0].ID+`"}`))
	if err == nil {
		t.Fatal("other credential read owned job")
	}
	if _, err := service.Credentials.Revoke(t.Context(), owner.ID); err != nil {
		t.Fatal(err)
	}
	_, err = download.Call(ownerContext, []byte(`{"jobId":"`+created[0].ID+`","position":0}`))
	if !errors.Is(err, ErrCredentialUnauthorized) {
		t.Fatalf("revoked download error = %v", err)
	}
}

func TestMCPExportArgumentsAllowMOVButRejectPaths(t *testing.T) {
	valid := projects.ExportInput{Mode: "merge", Selection: "segments", CutStrategy: "stream_copy_preferred", Container: "mov", DestinationID: "download"}
	if !validMCPExport(valid) {
		t.Fatal("MOV export rejected")
	}
	valid.FilenameTemplate = "../../outside"
	if validMCPExport(valid) {
		t.Fatal("path-like filename accepted")
	}
	valid.FilenameTemplate = "cut"
	valid.DestinationID = "/tmp"
	if validMCPExport(valid) {
		t.Fatal("filesystem destination accepted")
	}
}

func toolNamed(t *testing.T, tools []Tool, name string) Tool {
	t.Helper()
	for _, tool := range tools {
		if tool.Name == name {
			return tool
		}
	}
	t.Fatalf("tool %q not found", name)
	return Tool{}
}
