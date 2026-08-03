package adapters

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"editapp/application"
	"editapp/infrastructure/media/index"
	"editapp/infrastructure/media/probe"
	"editapp/infrastructure/store"
)

func TestMediaAPIShapeHidesStorageAndProviderMetadata(t *testing.T) {
	item := index.Media{
		ID:   "m_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		Name: "clip.mp4",
		Metadata: probe.Metadata{Video: &probe.Video{
			Codec: "h264", Width: 1280, Height: 720, AvgFrameRate: "30/1",
		}},
	}
	response, err := json.Marshal(media(item))
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

type adapterProbe struct{}

func (adapterProbe) ProbeFile(context.Context, *os.File) (probe.Metadata, error) {
	return probe.Metadata{}, nil
}

func TestMediaCatalogPreviewRejectsChangedSource(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	path := filepath.Join(root, "clip.mp4")
	if err := os.WriteFile(path, []byte("old"), 0o600); err != nil {
		t.Fatal(err)
	}
	scanner, err := index.NewScanner([]index.Root{{Alias: "camera", Path: root}}, adapterProbe{})
	if err != nil {
		t.Fatal(err)
	}
	db, err := store.OpenDatabase(ctx, filepath.Join(t.TempDir(), "editapp.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	mediaStore, err := store.NewMediaStore(db)
	if err != nil {
		t.Fatal(err)
	}
	catalog := MediaCatalog{Scanner: scanner, Store: mediaStore}
	if err := catalog.Refresh(ctx); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("changed"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err = catalog.Preview(ctx, application.PreviewSpec{MediaID: index.MediaID("camera", "clip.mp4")})
	if !errors.Is(err, index.ErrSourceChanged) {
		t.Fatalf("preview error = %v, want %v", err, index.ErrSourceChanged)
	}
}
