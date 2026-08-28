package adapters

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"videocutlist/application"
	"videocutlist/domain"
	"videocutlist/infrastructure/export"
	"videocutlist/infrastructure/ffmpeg"
	"videocutlist/infrastructure/media/index"
	"videocutlist/infrastructure/media/probe"
	"videocutlist/infrastructure/store"
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
	spec, err := catalog.Preview(ctx, application.PreviewSpec{MediaID: index.MediaID("camera", "clip.mp4")})
	if err != nil {
		t.Fatalf("Preview error = %v", err)
	}
	if spec.SizeBytes != 3 || spec.MtimeNS == 0 {
		t.Fatalf("preview spec fingerprint = (%d, %d), want catalog metadata", spec.SizeBytes, spec.MtimeNS)
	}
}

func TestExportSourceCancellationPersistsCancelled(t *testing.T) {
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
	if err := mediaStore.Sync(ctx, "camera", []index.Record{{Media: index.Media{ID: index.MediaID("camera", "clip.mp4"), SizeBytes: 3, MtimeNS: 1}}}); err != nil {
		t.Fatal(err)
	}
	projects, err := store.NewProjectStore(db)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := projects.Save(ctx, "owner", "project", 0, `{}`); err != nil {
		t.Fatal(err)
	}
	jobs, err := store.NewJobStore(db)
	if err != nil {
		t.Fatal(err)
	}
	jobID := "j_cancel_open"
	if _, err := jobs.Create(ctx, store.ExportJob{ID: jobID, OwnerLogin: "owner", ProjectID: "project", ProjectRevision: 1, RequestJSON: `{}`}); err != nil {
		t.Fatal(err)
	}
	executor := ExportExecutor{Jobs: jobs, Scanner: scanner, Media: mediaStore}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if err := executor.Execute(cancelled, "owner", jobID, domain.Document{MediaID: index.MediaID("camera", "clip.mp4")}); !errors.Is(err, context.Canceled) {
		t.Fatalf("Execute error = %v, want cancellation", err)
	}
	job, err := jobs.Get(ctx, "owner", jobID)
	if err != nil {
		t.Fatal(err)
	}
	if job.State != store.JobCancelled {
		t.Fatalf("job state = %q, want cancelled", job.State)
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
	projects, err := store.NewProjectStore(db)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := projects.Save(ctx, "owner", "project", 0, `{}`); err != nil {
		t.Fatal(err)
	}
	jobs, err := store.NewJobStore(db)
	if err != nil {
		t.Fatal(err)
	}
	executor := ExportExecutor{Jobs: jobs, Coordinator: export.Coordinator{Exporter: export.Service{OutputDir: root, Artifacts: export.NewArtifactStore()}}}
	create := func(t *testing.T, id string, result export.Result) {
		t.Helper()
		resultJSON, err := json.Marshal(result)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := jobs.Create(ctx, store.ExportJob{ID: id, OwnerLogin: "owner", ProjectID: "project", ProjectRevision: 1, RequestJSON: `{}`}); err != nil {
			t.Fatal(err)
		}
		if _, err := jobs.Start(ctx, "owner", id); err != nil {
			t.Fatal(err)
		}
		if _, err := jobs.Succeed(ctx, "owner", id, string(resultJSON)); err != nil {
			t.Fatal(err)
		}
	}
	fresh := time.Now().Add(time.Hour)
	create(t, "j_download_ok", export.Result{OutputName: "export.mkv", RetainUntil: fresh, DestinationKind: export.KindDownload})
	file, name, err := executor.Download(ctx, domain.Principal{Subject: "owner"}, "j_download_ok", 0)
	if err != nil || name != "export.mkv" {
		t.Fatalf("Download() = (%q, %v), want public download", name, err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}

	create(t, "j_download_expired", export.Result{OutputName: "export.mkv", RetainUntil: time.Now().Add(-time.Hour), DestinationKind: export.KindDownload})
	create(t, "j_download_archive", export.Result{OutputName: "export.mkv", RetainUntil: fresh, DestinationKind: export.KindArchive})
	create(t, "j_download_source", export.Result{OutputName: "export.mkv", RetainUntil: fresh, DestinationKind: export.KindSourceAdjacent})
	if _, err := jobs.Create(ctx, store.ExportJob{ID: "j_download_cancelled", OwnerLogin: "owner", ProjectID: "project", ProjectRevision: 1, RequestJSON: `{}`}); err != nil {
		t.Fatal(err)
	}
	if _, err := jobs.Cancel(ctx, "owner", "j_download_cancelled"); err != nil {
		t.Fatal(err)
	}
	other, _, err := executor.Download(ctx, domain.Principal{Subject: "other"}, "j_download_ok", 0)
	if err != nil {
		t.Fatalf("single-user download = %v", err)
	}
	if err := other.Close(); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct{ owner, id string }{
		{"owner", "j_download_expired"},
		{"owner", "j_download_archive"},
		{"owner", "j_download_source"},
		{"owner", "j_download_cancelled"},
	} {
		if _, _, err := executor.Download(ctx, domain.Principal{Subject: test.owner}, test.id, 0); err == nil {
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
	spec, err := catalog.Preview(ctx, application.PreviewSpec{MediaID: id, WindowMS: 1})
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
