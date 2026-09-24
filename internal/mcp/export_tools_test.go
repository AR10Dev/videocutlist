package mcp

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	jobqueue "videocutlist/internal/jobs"
	"videocutlist/internal/projects"
)

type exportToolDownload struct{ data []byte }

func (d exportToolDownload) Download(context.Context, string, int) (io.ReadCloser, string, error) {
	return io.NopCloser(bytes.NewReader(d.data)), "cut.mp4", nil
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
	downloads := exportToolDownload{data: bytes.Repeat([]byte("x"), 1<<20)}
	tools := ExportTools(service, service.Scheduler, downloads)
	ownerContext := Context{Request: httptest.NewRequest("POST", "/mcp", nil), Credential: owner.Credential}
	getJob := toolNamed(t, tools, "get_job")
	result, err := getJob.Call(ownerContext, []byte(`{"jobId":"`+created[0].ID+`"}`))
	if err != nil || result.StructuredContent["id"] != created[0].ID {
		t.Fatalf("owned get_job = %#v, %v", result, err)
	}
	download := toolNamed(t, tools, "get_export_download")
	result, err = download.Call(ownerContext, []byte(`{"jobId":"`+created[0].ID+`","position":0}`))
	url, _ := result.StructuredContent["url"].(string)
	if err != nil || url != exportDownloadPath+created[0].ID+"/0" {
		t.Fatalf("owned download = %#v, %v", result, err)
	}
	downloadHandler, err := ExportDownloadHandler(TransportConfig{
		Enabled: true, Credentials: service.Credentials,
		RequestInfo: func(*http.Request) RequestInfo { return RequestInfo{ClientIP: net.ParseIP("127.0.0.1"), Proto: "http"} },
	}, service, service.Scheduler, downloads)
	if err != nil {
		t.Fatal(err)
	}
	downloadRequest := httptest.NewRequest(http.MethodGet, url, nil)
	downloadRequest.Header.Set("Authorization", "Bearer "+owner.Secret)
	downloadResponse := httptest.NewRecorder()
	downloadHandler.ServeHTTP(downloadResponse, downloadRequest)
	if downloadResponse.Code != http.StatusOK || downloadResponse.Body.Len() != len(downloads.data) || downloadResponse.Header().Get("Content-Type") != "video/mp4" {
		t.Fatalf("large protected download status=%d size=%d headers=%v", downloadResponse.Code, downloadResponse.Body.Len(), downloadResponse.Header())
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
	downloadResponse = httptest.NewRecorder()
	downloadHandler.ServeHTTP(downloadResponse, downloadRequest)
	if downloadResponse.Code != http.StatusUnauthorized {
		t.Fatalf("revoked protected download status=%d", downloadResponse.Code)
	}
}

type rejectedCancellationJobs struct{ *jobqueue.Scheduler }

func (rejectedCancellationJobs) Cancel(context.Context, string) (jobqueue.Job, error) {
	return jobqueue.Job{}, jobqueue.ErrJobState
}

func TestCancelJobRejectsCompletedJob(t *testing.T) {
	service, _, _, _, now := newProposalTestService(t, false)
	expires := now.Add(time.Hour)
	owner, err := service.Credentials.Create(t.Context(), CredentialInput{
		Name: "cancel owner", Permissions: []Permission{PermissionExportsPrepare, PermissionExportsRun, PermissionJobsCancel},
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
	store, err := jobqueue.NewJobsStore(service.db)
	if err != nil {
		t.Fatal(err)
	}
	id := created[0].ID
	if _, err := store.Start(t.Context(), id); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Succeed(t.Context(), id, `{}`); err != nil {
		t.Fatal(err)
	}
	ctx := Context{Request: httptest.NewRequest("POST", "/mcp", nil), Credential: owner.Credential}
	cancel := toolNamed(t, ExportTools(service, rejectedCancellationJobs{service.Scheduler}, exportToolDownload{}), "cancel_job")
	if _, err := cancel.Call(ctx, []byte(`{"jobId":"`+id+`"}`)); !errors.Is(err, jobqueue.ErrJobState) {
		t.Fatalf("completed job cancellation = %v, want invalid transition", err)
	}
	job, err := store.Get(t.Context(), id)
	if err != nil || job.State != jobqueue.JobSucceeded {
		t.Fatalf("completed job after cancellation = %+v, %v", job, err)
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
