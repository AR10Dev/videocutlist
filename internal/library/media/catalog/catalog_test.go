package catalog

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	store "videocutlist/internal/db"
	"videocutlist/internal/library/media/index"
	"videocutlist/internal/library/media/probe"
	previewdomain "videocutlist/internal/preview"
)

type catalogTestProbe struct{}

func (catalogTestProbe) ProbeFile(context.Context, *os.File) (probe.Metadata, error) {
	return probe.Metadata{}, nil
}

func TestMediaAPIShapeHidesStorageAndProviderMetadata(t *testing.T) {
	item := index.Media{
		ID:   "m_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		Name: "clip.mp4",
		Metadata: probe.Metadata{Video: &probe.Video{
			Codec: "h264", Width: 1280, Height: 720, AvgFrameRate: "30/1",
		}},
	}
	response, err := json.Marshal(media(item, "private-root-alias"))
	if err != nil {
		t.Fatal(err)
	}
	var top map[string]json.RawMessage
	if err := json.Unmarshal(response, &top); err != nil {
		t.Fatal(err)
	}
	for field := range top {
		if strings.Contains(string(response), "private-root-alias") {
			t.Fatalf("media response exposed private root: %s", response)
		}
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
		if field != "video" && field != "audio" && field != "tracks" {
			t.Fatalf("media streams exposed %q: %s", field, response)
		}
	}
}

func TestMediaCatalogListRetainsInternalRootForScopedConsumers(t *testing.T) {
	ctx := t.Context()
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "clip.mp4"), []byte("media"), 0o600); err != nil {
		t.Fatal(err)
	}
	scanner, err := index.NewScanner([]index.Root{{Alias: "camera", Path: root}}, catalogTestProbe{})
	if err != nil {
		t.Fatal(err)
	}
	database, err := store.OpenDatabase(ctx, filepath.Join(t.TempDir(), "videocutlist.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := database.Close(); err != nil {
			t.Error(err)
		}
	}()
	mediaStore, err := store.NewMediaStore(database)
	if err != nil {
		t.Fatal(err)
	}
	mediaCatalog := MediaCatalog{Scanner: scanner, Store: mediaStore}
	if err := mediaCatalog.Refresh(ctx); err != nil {
		t.Fatal(err)
	}
	page, err := mediaCatalog.List(ctx, "", 1)
	if err != nil || len(page.Items) != 1 || page.Items[0].RootID != "camera" {
		t.Fatalf("List() = %#v, %v; want internal root ID", page, err)
	}
	encoded, err := json.Marshal(page)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), `"rootId"`) || strings.Contains(string(encoded), "camera") {
		t.Fatalf("public media page exposed scoped root identity: %s", encoded)
	}
	record, err := mediaStore.Get(ctx, page.Items[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	if page.Items[0].ETag != index.SourceFingerprint(record.Media) {
		t.Fatalf("media ETag = %q, want source fingerprint %q", page.Items[0].ETag, index.SourceFingerprint(record.Media))
	}
}

func TestMediaCatalogPreviewRejectsChangedSourceBeforeCacheLookup(t *testing.T) {
	ctx := t.Context()
	root := t.TempDir()
	path := filepath.Join(root, "clip.mp4")
	if err := os.WriteFile(path, []byte("old"), 0o600); err != nil {
		t.Fatal(err)
	}
	scanner, err := index.NewScanner([]index.Root{{Alias: "camera", Path: root}}, catalogTestProbe{})
	if err != nil {
		t.Fatal(err)
	}
	database, err := store.OpenDatabase(ctx, filepath.Join(t.TempDir(), "videocutlist.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := database.Close(); err != nil {
			t.Error(err)
		}
	})
	mediaStore, err := store.NewMediaStore(database)
	if err != nil {
		t.Fatal(err)
	}
	mediaCatalog := MediaCatalog{Scanner: scanner, Store: mediaStore}
	if err := mediaCatalog.Refresh(ctx); err != nil {
		t.Fatal(err)
	}
	id := index.MediaID("camera", "clip.mp4")
	request := previewdomain.PreviewSpec{MediaID: id, WindowMS: 1}
	if _, err := mediaCatalog.Preview(ctx, request); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("changed"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := mediaCatalog.Preview(ctx, request); !errors.Is(err, index.ErrSourceChanged) {
		t.Fatalf("preview spec after source change = %v, want %v", err, index.ErrSourceChanged)
	}
	if err := mediaCatalog.Refresh(ctx); err != nil {
		t.Fatal(err)
	}
	spec, err := mediaCatalog.Preview(ctx, request)
	if err != nil || spec.SizeBytes != int64(len("changed")) {
		t.Fatalf("preview after refresh = %+v, %v", spec, err)
	}
}
