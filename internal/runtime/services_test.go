package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"videocutlist/internal/db"
	"videocutlist/internal/export"
	jobqueue "videocutlist/internal/jobs"
	"videocutlist/internal/library/media/index"
	"videocutlist/internal/library/media/probe"
	"videocutlist/internal/preview/ffmpeg"
	"videocutlist/internal/projects"
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
		if field != "video" && field != "audio" && field != "tracks" {
			t.Fatalf("media streams exposed %q: %s", field, response)
		}
	}
}

type adapterProbe struct{}

func (adapterProbe) ProbeFile(context.Context, *os.File) (probe.Metadata, error) {
	return probe.Metadata{}, nil
}

func TestMediaCatalogPreviewUsesCatalogMetadata(t *testing.T) {
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
	spec, err := catalog.Preview(ctx, projects.PreviewSpec{MediaID: index.MediaID("camera", "clip.mp4")})
	if err != nil {
		t.Fatalf("Preview error = %v", err)
	}
	if spec.SizeBytes != 3 || spec.MtimeNS == 0 {
		t.Fatalf("preview spec fingerprint = (%d, %d), want catalog metadata", spec.SizeBytes, spec.MtimeNS)
	}
}

func TestExportDownloadEnforcesDurableLifecycle(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "export.mkv"), []byte("video bytes"), 0o600); err != nil {
		t.Fatal(err)
	}
	db, err := store.OpenDatabase(ctx, filepath.Join(t.TempDir(), "videocutlist.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	jobs, err := jobqueue.NewJobsStore(db)
	if err != nil {
		t.Fatal(err)
	}
	executor := ExportExecutor{Jobs: jobs, Service: export.Service{OutputDir: root, Artifacts: export.NewArtifactStore()}}
	create := func(t *testing.T, id string, result export.Result) {
		t.Helper()
		resultJSON, err := json.Marshal(result)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := jobs.Create(ctx, jobqueue.Job{ID: id, BatchID: "b_" + id, Kind: jobqueue.JobExport, ProjectID: "project", ProjectItemID: "item", RequestJSON: `{}`}); err != nil {
			t.Fatal(err)
		}
		if _, err := jobs.Start(ctx, id); err != nil {
			t.Fatal(err)
		}
		if _, err := jobs.Succeed(ctx, id, string(resultJSON)); err != nil {
			t.Fatal(err)
		}
	}
	fresh := time.Now().Add(time.Hour)
	create(t, "j_download_ok0", export.Result{OutputName: "export.mkv", RetainUntil: fresh, DestinationKind: export.KindDownload})
	file, name, err := executor.Download(ctx, "j_download_ok0", 0)
	if err != nil || name != "export.mkv" {
		t.Fatalf("Download() = (%q, %v), want public download", name, err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}

	create(t, "j_download_expired0", export.Result{OutputName: "export.mkv", RetainUntil: time.Now().Add(-time.Hour), DestinationKind: export.KindDownload})
	create(t, "j_download_archive0", export.Result{OutputName: "export.mkv", RetainUntil: fresh, DestinationKind: export.KindArchive})
	create(t, "j_download_source0", export.Result{OutputName: "export.mkv", RetainUntil: fresh, DestinationKind: export.KindSourceAdjacent})
	if _, err := jobs.Create(ctx, jobqueue.Job{ID: "j_download_cancelled0", BatchID: "b_download_cancelled0", Kind: jobqueue.JobExport, ProjectID: "project", ProjectItemID: "item", RequestJSON: `{}`}); err != nil {
		t.Fatal(err)
	}
	if _, err := jobs.Cancel(ctx, "j_download_cancelled0"); err != nil {
		t.Fatal(err)
	}
	other, _, err := executor.Download(ctx, "j_download_ok0", 0)
	if err != nil {
		t.Fatalf("single-user download = %v", err)
	}
	if err := other.Close(); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct{ owner, id string }{
		{"owner", "j_download_expired0"},
		{"owner", "j_download_archive0"},
		{"owner", "j_download_source0"},
		{"owner", "j_download_cancelled0"},
	} {
		if _, _, err := executor.Download(ctx, test.id, 0); err == nil {
			t.Fatalf("Download(%q, %q) succeeded", test.owner, test.id)
		}
	}
}

func TestPreviewRunnerRejectsChangedSourceForOldSpec(t *testing.T) {
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
	spec, err := catalog.Preview(ctx, projects.PreviewSpec{MediaID: id, WindowMS: 1})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("changed"), 0o600); err != nil {
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
