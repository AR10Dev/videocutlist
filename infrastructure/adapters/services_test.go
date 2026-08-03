package adapters

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"editapp/application"
	"editapp/domain"
	"editapp/infrastructure/media/index"
	"editapp/infrastructure/media/probe"
)

func TestAdmissionRejectsBusyWorkBeforeDependencies(t *testing.T) {
	media := &MediaAdapter{refreshing: true}
	principal := domain.Principal{Subject: "editor"}
	if _, err := media.RefreshMedia(context.Background(), principal); !errors.Is(err, application.ErrBusy) {
		t.Fatalf("refresh error = %v", err)
	}

	exports := &ExportAdapter{slots: make(chan struct{}, 1)}
	exports.slots <- struct{}{}
	if _, err := exports.Create(context.Background(), principal, "p_project", application.Project{}, application.ExportInput{}); !errors.Is(err, application.ErrBusy) {
		t.Fatalf("export error = %v", err)
	}
}

func TestMediaAPIShapeHidesStorageAndProviderMetadata(t *testing.T) {
	media := index.Media{
		ID:   "m_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		Name: "clip.mp4",
		Metadata: probe.Metadata{Video: &probe.Video{
			Codec: "h264", Width: 1280, Height: 720, AvgFrameRate: "30/1",
		}},
	}
	response, err := json.Marshal(apiMedia(media))
	if err != nil {
		t.Fatal(err)
	}
	var top map[string]json.RawMessage
	if err := json.Unmarshal(response, &top); err != nil {
		t.Fatal(err)
	}
	for field := range top {
		switch field {
		case "id", "name", "durationMs", "sizeBytes", "container", "streams", "etag":
		default:
			t.Fatalf("media response exposed %q: %s", field, response)
		}
	}
	var streams map[string]json.RawMessage
	if err := json.Unmarshal(top["streams"], &streams); err != nil {
		t.Fatal(err)
	}
	for field := range streams {
		if field != "video" && field != "audio" {
			t.Fatalf("media streams exposed %q: %s", field, response)
		}
	}
}
