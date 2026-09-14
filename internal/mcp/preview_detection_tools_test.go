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

func testRequest() *http.Request { return httptest.NewRequest("POST", "/mcp", nil) }
