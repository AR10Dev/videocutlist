package adapters

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"videocutlist/application"
	"videocutlist/infrastructure/ffmpeg"
	"videocutlist/infrastructure/media/index"
	"videocutlist/infrastructure/media/probe"
	"videocutlist/infrastructure/store"
)

func TestExportJobCarriesDurableErrorCode(t *testing.T) {
	created := time.Date(2026, 8, 13, 12, 0, 0, 0, time.UTC)
	job := exportJob(store.ExportJob{ID: "j_aaaaaaaaaaaa", OwnerLogin: "editor", State: store.JobFailed, ErrorCode: sql.NullString{String: "media_unavailable", Valid: true}, CreatedAt: created, UpdatedAt: created})
	if job.ErrorCode == nil || *job.ErrorCode != "media_unavailable" {
		t.Fatalf("job error code = %#v", job.ErrorCode)
	}
}

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
	db, err := store.OpenDatabase(ctx, filepath.Join(t.TempDir(), "videocutlist.db"))
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

func TestPreviewRunnerRejectsRefreshedSourceForOldSpec(t *testing.T) {
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
	db, err := store.OpenDatabase(ctx, filepath.Join(t.TempDir(), "videocutlist.db"))
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
	id := index.MediaID("camera", "clip.mp4")
	spec, err := catalog.Preview(ctx, application.PreviewSpec{MediaID: id, WindowMS: 1})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("changed"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := catalog.Refresh(ctx); err != nil {
		t.Fatal(err)
	}
	runner := PreviewRunner{Scanner: scanner, Media: mediaStore, FFmpeg: ffmpeg.Runner{Path: filepath.Join(t.TempDir(), "missing-ffmpeg")}}
	if running, err := runner.Start(ctx, spec); !errors.Is(err, index.ErrSourceChanged) {
		if running != nil {
			_ = running.Stdout.Close()
		}
		t.Fatalf("runner error = %v, want %v", err, index.ErrSourceChanged)
	}
}
