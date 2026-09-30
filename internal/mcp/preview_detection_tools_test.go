package mcp

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
	store "videocutlist/internal/db"
	"videocutlist/internal/projects"
	"videocutlist/internal/projects/model"
)

type previewToolMedia struct{ item projects.Media }

func (m previewToolMedia) List(context.Context, string, int) (projects.MediaPage, error) {
	return projects.MediaPage{Items: []projects.Media{m.item}}, nil
}
func (m previewToolMedia) Get(_ context.Context, id string) (projects.Media, error) {
	if id != m.item.ID {
		return projects.Media{}, errors.New("media unavailable")
	}
	return m.item, nil
}

type previewToolPreview struct{ data []byte }

func (p previewToolPreview) Start(context.Context, projects.PreviewSpec) (projects.PreviewResult, error) {
	return projects.PreviewResult{Reader: io.NopCloser(bytes.NewReader(p.data)), StartMS: 0, DurationMS: 1000}, nil
}

type previewToolDetection struct{ request projects.DetectionRequest }

func (d *previewToolDetection) Create(_ context.Context, projectID string, request projects.DetectionRequest) (projects.DetectionJob, error) {
	d.request = request
	return projects.DetectionJob{ID: "j_aaaaaaaaaaaa", Type: "detection", State: "queued", ProjectID: projectID, MediaID: request.MediaID, Kind: request.Kind}, nil
}

type previewToolProjects struct{ project projects.Project }

func (s previewToolProjects) Create(context.Context, string, projects.ProjectInput) (projects.Project, error) {
	return projects.Project{}, nil
}
func (s previewToolProjects) Save(context.Context, string, projects.ProjectInput) (projects.Project, error) {
	return projects.Project{}, nil
}
func (s previewToolProjects) Get(context.Context, string) (projects.Project, error) {
	return s.project, nil
}
func (s previewToolProjects) List(context.Context, string, int) (projects.ProjectPage, error) {
	return projects.ProjectPage{}, nil
}

func TestPreviewDetectionToolsUseBoundedOpaqueInputs(t *testing.T) {
	mediaID := "m_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	media := previewToolMedia{item: projects.Media{ID: mediaID, RootID: "root", DurationMS: 10_000}}
	project := previewToolProjects{project: projects.Project{ID: "p_test", Revision: 1, Document: model.Document{Items: []model.ProjectItem{{ID: "i_aaaaaaaaaaaaaaaaaaaaaaaa", MediaID: mediaID}}}}}
	detection := &previewToolDetection{}
	tools := PreviewDetectionTools(media, previewToolPreview{data: []byte("preview")}, detection, project)
	preview := toolNamed(t, tools, "create_preview")
	if preview.Permission != PermissionPreviewsCreate {
		t.Fatalf("preview permission = %q", preview.Permission)
	}
	ctx := Context{Request: testRequest(), Credential: Credential{ID: "c_owner"}}
	result, err := preview.Call(ctx, []byte(`{"mediaId":"`+mediaID+`","centerMs":1000,"beforeMs":500,"afterMs":500,"mute":true}`))
	if err != nil || result.StructuredContent["data"] == "" {
		t.Fatalf("preview = %#v, %v", result, err)
	}
	result, err = preview.Call(ctx, []byte(`{"mediaId":"`+mediaID+`","centerMs":0,"beforeMs":0,"afterMs":500,"mute":false}`))
	if err != nil || result.StructuredContent["data"] == "" {
		t.Fatalf("explicit zero/false preview = %#v, %v", result, err)
	}
	if _, err := preview.Call(ctx, []byte(`{"mediaId":"/tmp/clip","centerMs":0,"beforeMs":1,"afterMs":1,"mute":true}`)); err == nil {
		t.Fatal("path-like media ID accepted")
	}
	tooLarge := PreviewDetectionTools(media, previewToolPreview{data: make([]byte, base64.StdEncoding.DecodedLen(maxPreviewBase64Bytes)+1)}, detection, project)
	if _, err := toolNamed(t, tooLarge, "create_preview").Call(ctx, []byte(`{"mediaId":"`+mediaID+`","centerMs":1000,"beforeMs":500,"afterMs":500,"mute":true}`)); err == nil {
		t.Fatal("oversize base64 preview accepted")
	}
	start := toolNamed(t, tools, "start_detection")
	result, err = start.Call(ctx, []byte(`{"projectId":"p_test","projectItemId":"i_aaaaaaaaaaaaaaaaaaaaaaaa","mediaId":"`+mediaID+`","projectRevision":1,"kind":"scene"}`))
	if err != nil || result.StructuredContent["id"] == "" || detection.request.CredentialID != "c_owner" || detection.request.Kind != model.DetectScene {
		t.Fatalf("detection = %#v, request=%#v, err=%v", result, detection.request, err)
	}
	if start.Permission != PermissionDetectionRun {
		t.Fatalf("detection permission = %q", start.Permission)
	}
}

func TestPreviewDetectionToolsRejectInvalidInput(t *testing.T) {
	mediaID := "m_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	media := previewToolMedia{item: projects.Media{ID: mediaID, RootID: "root", DurationMS: 10_000}}
	project := previewToolProjects{project: projects.Project{ID: "p_test", Revision: 1}}
	tools := PreviewDetectionTools(media, previewToolPreview{}, &previewToolDetection{}, project)
	ctx := Context{Request: testRequest()}
	for _, test := range []struct {
		name, arguments string
	}{
		{"create_preview", `{"centerMs":0,"beforeMs":1,"afterMs":1,"mute":false}`},
		{"create_preview", `{"mediaId":"/tmp/private","centerMs":0,"beforeMs":1,"afterMs":1,"mute":false}`},
		{"create_preview", `{"mediaId":"` + mediaID + `","beforeMs":1,"afterMs":1,"mute":false}`},
		{"create_preview", `{"mediaId":"` + mediaID + `","centerMs":0,"afterMs":1,"mute":false}`},
		{"create_preview", `{"mediaId":"` + mediaID + `","centerMs":0,"beforeMs":1,"mute":false}`},
		{"create_preview", `{"mediaId":"` + mediaID + `","centerMs":0,"beforeMs":1,"afterMs":1}`},
		{"create_preview", `{"mediaId":"` + mediaID + `","centerMs":null,"beforeMs":1,"afterMs":1,"mute":false}`},
		{"create_preview", `{"mediaId":"` + mediaID + `","centerMs":0,"beforeMs":1,"afterMs":1,"mute":null}`},
		{"create_preview", `{"mediaId":"` + mediaID + `","centerMs":0,"beforeMs":9223372036854775807,"afterMs":1,"mute":false}`},
		{"start_detection", `{"projectItemId":"i_aaaaaaaaaaaaaaaaaaaaaaaa","mediaId":"` + mediaID + `","projectRevision":1,"kind":"scene"}`},
		{"start_detection", `{"projectId":"p_test","projectItemId":"i_aaaaaaaaaaaaaaaaaaaaaaaa","projectRevision":1,"kind":"scene"}`},
		{"start_detection", `{"projectId":"p_test","projectItemId":"i_aaaaaaaaaaaaaaaaaaaaaaaa","mediaId":"` + mediaID + `","projectRevision":1,"kind":"unknown"}`},
		{"start_detection", `{"projectId":"p_test","projectItemId":"i_aaaaaaaaaaaaaaaaaaaaaaaa","mediaId":"` + mediaID + `","projectRevision":1}`},
		{"start_detection", `{"projectId":"p_test","projectItemId":"i_aaaaaaaaaaaaaaaaaaaaaaaa","mediaId":"` + mediaID + `","projectRevision":null,"kind":"scene"}`},
	} {
		t.Run(test.name+"/"+test.arguments, func(t *testing.T) {
			tool := toolNamed(t, tools, test.name)
			if _, err := tool.Resource(ctx, []byte(test.arguments)); !errors.Is(err, ErrInvalidInput) || toolErrorCode(err) != "invalid_input" {
				t.Fatalf("invalid resource arguments = %v, code=%q", err, toolErrorCode(err))
			}
			if _, err := tool.Call(ctx, []byte(test.arguments)); !errors.Is(err, ErrInvalidInput) || toolErrorCode(err) != "invalid_input" {
				t.Fatalf("invalid call arguments = %v, code=%q", err, toolErrorCode(err))
			}
		})
	}
}

func testRequest() *http.Request { return httptest.NewRequest("POST", "/mcp", nil) }

func TestDetectionTransportAuthorizesSelectedMedia(t *testing.T) {
	database, err := store.OpenDatabase(t.Context(), t.TempDir()+"/detection.db")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	credentials, err := NewCredentialStoreWithClock(database, time.Now)
	if err != nil {
		t.Fatal(err)
	}
	expires := time.Now().Add(time.Hour)
	created, err := credentials.Create(t.Context(), CredentialInput{
		Name: "detection", Permissions: []Permission{PermissionMediaRead, PermissionProjectsRead, PermissionDetectionRun},
		MediaScope:   MediaScope{Kind: MediaScopeRoots, RootIDs: []string{"root"}},
		ProjectScope: ProjectScope{Kind: ProjectScopeAll}, ExpiresAt: &expires,
	})
	if err != nil {
		t.Fatal(err)
	}
	credential, err := credentials.Authenticate(t.Context(), created.Secret)
	if err != nil {
		t.Fatal(err)
	}
	mediaID := "m_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	media := previewToolMedia{item: projects.Media{ID: mediaID, RootID: "root", DurationMS: 10_000}}
	project := previewToolProjects{project: projects.Project{ID: "p_test", Revision: 1, Document: model.Document{Items: []model.ProjectItem{{ID: "i_aaaaaaaaaaaaaaaaaaaaaaaa", MediaID: mediaID}}}}}
	detection := &previewToolDetection{}
	transport := &transport{config: TransportConfig{Credentials: credentials, Tools: PreviewDetectionTools(media, previewToolPreview{}, detection, project)}}
	result, rpcErr := transport.callTool(testRequest(), []byte(`{"name":"start_detection","arguments":{"projectId":"p_test","projectItemId":"i_aaaaaaaaaaaaaaaaaaaaaaaa","mediaId":"`+mediaID+`","projectRevision":1,"kind":"scene"}}`), credential)
	if rpcErr != nil {
		t.Fatalf("authorized detection rejected: %#v", rpcErr)
	}
	toolResult, ok := result.(ToolResult)
	if !ok || toolResult.IsError || toolResult.StructuredContent["id"] != "j_aaaaaaaaaaaa" {
		t.Fatalf("detection did not return queued job: %#v", result)
	}
	result, rpcErr = transport.callTool(testRequest(), []byte(`{"name":"start_detection","arguments":{"projectItemId":"i_aaaaaaaaaaaaaaaaaaaaaaaa","mediaId":"`+mediaID+`","projectRevision":1,"kind":"scene"}}`), credential)
	if rpcErr != nil {
		t.Fatalf("invalid tool arguments returned RPC error: %#v", rpcErr)
	}
	toolResult, ok = result.(ToolResult)
	if !ok || !toolResult.IsError {
		t.Fatalf("missing project ID did not return a tool error: %#v", result)
	}
	publicError, ok := toolResult.StructuredContent["error"].(map[string]any)
	if !ok || publicError["code"] != "invalid_input" {
		t.Fatalf("invalid tool arguments error envelope = %#v", toolResult.StructuredContent)
	}
}
