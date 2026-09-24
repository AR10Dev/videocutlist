package runtime

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
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
	"videocutlist/internal/projects/model"
)

func TestPreflightItemsSelectsProjectItemsInDocumentOrder(t *testing.T) {
	project := projects.Project{Document: model.Document{Items: []model.ProjectItem{
		{ID: "i_first"},
		{ID: "i_second"},
	}}}
	items, err := preflightItems(project, []string{"i_second", "i_first"})
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 2 || items[0].ID != "i_first" || items[1].ID != "i_second" {
		t.Fatalf("selected items = %#v", items)
	}
	if _, err := preflightItems(project, []string{"i_first", "i_first"}); err == nil {
		t.Fatal("duplicate item selection was accepted")
	}
	if _, err := preflightItems(project, []string{"i_missing"}); err == nil {
		t.Fatal("unknown item selection was accepted")
	}
}

func TestPreflightRequestUsesPersistedOptionsForSelectedItems(t *testing.T) {
	item := model.ProjectItem{ExportOptions: model.ExportOptions{
		Mode: "separate", Selection: "gaps", CutStrategy: "precise_reencode", Container: "mkv",
		DestinationID: "archive", FilenameTemplate: "saved-{segment}.{ext}", StreamIndexes: []int{1},
	}}
	request := preflightRequest(item, projects.ExportInput{
		Mode: "merge", Selection: "segments", CutStrategy: "stream_copy_preferred", Container: "mkv",
		DestinationID: "download", FilenameTemplate: "request-{segment}.{ext}", StreamIndexes: []int{0},
	}, false)
	if request.Mode != "separate" || request.Selection != "gaps" || request.CutStrategy != "precise_reencode" || request.DestinationID != "archive" || len(request.StreamIndexes) != 1 || request.StreamIndexes[0] != 1 {
		t.Fatalf("preflight request = %#v", request)
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
		if field != "video" && field != "audio" && field != "tracks" {
			t.Fatalf("media streams exposed %q: %s", field, response)
		}
	}
}

type adapterProbe struct{}

type failingCloser struct{ err error }

func (c failingCloser) Close() error { return c.err }

func (adapterProbe) ProbeFile(context.Context, *os.File) (probe.Metadata, error) {
	return probe.Metadata{}, nil
}

func TestExportExecutorSourceClosePreservesPublishedResult(t *testing.T) {
	closeErr := errors.New("source close failed")
	if err := closeBatchSource(nil, failingCloser{err: closeErr}); err != nil {
		t.Fatalf("successful export close error = %v; want ignored cleanup error", err)
	}
	primary := errors.New("export failed")
	err := closeBatchSource(primary, failingCloser{err: closeErr})
	if !errors.Is(err, primary) || !errors.Is(err, closeErr) {
		t.Fatalf("primary=%v, want primary and cleanup errors", err)
	}
}

func TestMediaCatalogListRetainsInternalRootForScopedConsumers(t *testing.T) {
	ctx := t.Context()
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "clip.mp4"), []byte("media"), 0o600); err != nil {
		t.Fatal(err)
	}
	scanner, err := index.NewScanner([]index.Root{{Alias: "camera", Path: root}}, adapterProbe{})
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
	catalog := MediaCatalog{Scanner: scanner, Store: mediaStore}
	if err := catalog.Refresh(ctx); err != nil {
		t.Fatal(err)
	}
	page, err := catalog.List(ctx, "", 1)
	if err != nil || len(page.Items) != 1 || page.Items[0].RootID != "camera" {
		t.Fatalf("List() = %#v, %v; want internal root ID", page, err)
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
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Error(err)
		}
	})
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

func TestExportDownloadAfterRecoveryPreservesExpiryAndBytes(t *testing.T) {
	ctx := t.Context()
	root := t.TempDir()
	outputName := "recovered.mkv"
	expected := []byte("recovered output bytes")
	if err := os.WriteFile(filepath.Join(root, outputName), expected, 0o600); err != nil {
		t.Fatal(err)
	}
	ffprobe := filepath.Join(t.TempDir(), "ffprobe")
	const probeJSON = `{"format":{"duration":"1.0","format_name":"matroska"},"streams":[{"index":0,"codec_type":"video","codec_name":"h264","avg_frame_rate":"30/1","r_frame_rate":"30/1","disposition":{}}]}`
	if err := os.WriteFile(ffprobe, []byte("#!/bin/sh\nprintf '%s\\n' '"+probeJSON+"'\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	database, err := store.OpenDatabase(ctx, filepath.Join(t.TempDir(), "recovery.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := database.Close(); err != nil {
			t.Errorf("close database: %v", err)
		}
	})
	jobs, err := jobqueue.NewJobsStore(database)
	if err != nil {
		t.Fatal(err)
	}
	jobID := "j_recovered_download"
	if _, err := jobs.Create(ctx, jobqueue.Job{ID: jobID, BatchID: "b_recovered_download", Kind: jobqueue.JobExport, ProjectID: "project", ProjectItemID: "item", RequestJSON: `{}`}); err != nil {
		t.Fatal(err)
	}
	if _, err := jobs.Start(ctx, jobID); err != nil {
		t.Fatal(err)
	}
	expires := time.Now().UTC().Add(time.Hour)
	manifest, err := export.WriteManifest(root, jobID, export.KindDownload, []string{outputName}, expires)
	if err != nil {
		t.Fatal(err)
	}
	destination := export.Destination{ID: "browser", Kind: export.KindDownload, Root: root}
	artifacts := export.NewArtifactStore()
	if err := artifacts.Reconcile(ctx, jobs, ffprobe, []export.Destination{destination}); err != nil {
		t.Fatal(err)
	}
	executor := ExportExecutor{Jobs: jobs, Service: export.Service{OutputDir: t.TempDir(), Destinations: []export.Destination{destination}, Artifacts: artifacts}}
	file, name, err := executor.Download(ctx, jobID, 0)
	if err != nil {
		t.Fatalf("recovered Download() error = %v", err)
	}
	got, readErr := io.ReadAll(file)
	closeErr := file.Close()
	if readErr != nil || closeErr != nil {
		t.Fatalf("recovered Download() read=%v close=%v", readErr, closeErr)
	}
	if name != outputName || !bytes.Equal(got, expected) {
		t.Fatalf("recovered Download() = (%q, %q), want (%q, %q)", name, got, outputName, expected)
	}
	recovered, err := jobs.Get(ctx, jobID)
	if err != nil {
		t.Fatal(err)
	}
	var result export.Result
	if err := json.Unmarshal([]byte(recovered.ResultJSON.String), &result); err != nil {
		t.Fatal(err)
	}
	if !result.RetainUntil.Equal(expires) || result.DestinationID != destination.ID || result.DestinationKind != export.KindDownload {
		t.Fatalf("recovered result = %#v", result)
	}
	if _, err := os.Stat(manifest); err != nil {
		t.Fatalf("recovery manifest was not retained for restart: %v", err)
	}

	expiredID := "j_recovered_expired"
	expiredName := "expired.mkv"
	if err := os.WriteFile(filepath.Join(root, expiredName), expected, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := jobs.Create(ctx, jobqueue.Job{ID: expiredID, BatchID: "b_recovered_expired", Kind: jobqueue.JobExport, ProjectID: "project", ProjectItemID: "item", RequestJSON: `{}`}); err != nil {
		t.Fatal(err)
	}
	if _, err := jobs.Start(ctx, expiredID); err != nil {
		t.Fatal(err)
	}
	if _, err := export.WriteManifest(root, expiredID, export.KindDownload, []string{expiredName}, time.Now().UTC().Add(-time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err := artifacts.Reconcile(ctx, jobs, ffprobe, []export.Destination{destination}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := executor.Download(ctx, expiredID, 0); err == nil {
		t.Fatal("expired recovered output was downloadable")
	}
}

func TestBatchArchiveOutputNamesRejectPaths(t *testing.T) {
	for _, name := range []string{"../clip.mkv", "..", ".", "nested/clip.mkv", "clip\n.mkv"} {
		outputs, ok := resultOutputNames(export.Result{OutputName: name})
		if ok || outputs != nil {
			t.Fatalf("resultOutputNames(%q) accepted unsafe archive name", name)
		}
	}
}

func TestExportExecutorDownloadBatchPublishesValidatedArchive(t *testing.T) {
	ctx := t.Context()
	root := t.TempDir()
	for name, content := range map[string]string{"first.mkv": "first output", "second.mkv": "second output"} {
		if err := os.WriteFile(filepath.Join(root, name), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
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
	jobs, err := jobqueue.NewJobsStore(database)
	if err != nil {
		t.Fatal(err)
	}
	batchID := "b_aggregate1234"
	for id, name := range map[string]string{"j_aggregateone": "first.mkv", "j_aggregatetwo": "second.mkv"} {
		resultJSON, err := json.Marshal(export.Result{
			OutputName: name, SizeBytes: int64(len(name)), RetainUntil: time.Now().Add(time.Hour), DestinationKind: export.KindDownload,
		})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := jobs.Create(ctx, jobqueue.Job{ID: id, BatchID: batchID, Kind: jobqueue.JobExport, ProjectID: "project", ProjectItemID: id, RequestJSON: `{}`}); err != nil {
			t.Fatal(err)
		}
		if _, err := jobs.Start(ctx, id); err != nil {
			t.Fatal(err)
		}
		if _, err := jobs.Succeed(ctx, id, string(resultJSON)); err != nil {
			t.Fatal(err)
		}
	}
	executor := ExportExecutor{Jobs: jobs, Service: export.Service{OutputDir: root, Artifacts: export.NewArtifactStore()}}
	archiveFile, archiveName, err := executor.DownloadBatch(ctx, batchID)
	if err != nil {
		t.Fatal(err)
	}
	data, err := io.ReadAll(archiveFile)
	if closeErr := archiveFile.Close(); err != nil || closeErr != nil {
		t.Fatalf("read archive: read=%v close=%v", err, closeErr)
	}
	if archiveName == "" || filepath.Base(archiveName) != archiveName || filepath.Ext(archiveName) != ".zip" {
		t.Fatalf("archive name=%q", archiveName)
	}
	archive, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil || len(archive.File) != 2 {
		t.Fatalf("archive entries=%d err=%v", len(archive.File), err)
	}
	for _, entry := range archive.File {
		if filepath.Base(entry.Name) != entry.Name {
			t.Fatalf("archive entry leaked a path: %q", entry.Name)
		}
		entryReader, err := entry.Open()
		if err != nil {
			t.Fatal(err)
		}
		if _, err := io.ReadAll(entryReader); err != nil {
			t.Fatal(err)
		}
		if err := entryReader.Close(); err != nil {
			t.Fatal(err)
		}
	}
	cached, cachedName, err := executor.DownloadBatch(ctx, batchID)
	if err != nil || cachedName != archiveName {
		t.Fatalf("cached archive name=%q err=%v", cachedName, err)
	}
	if err := cached.Close(); err != nil {
		t.Fatal(err)
	}
	destination := export.Destination{ID: "download", Kind: export.KindDownload, Root: root}
	manifestPath := filepath.Join(root, ".videocutlist-export-"+batchID+".json")
	var recovered *export.ArtifactStore
	for range 2 {
		recovered = export.NewArtifactStore()
		if err := recovered.Reconcile(ctx, jobs, "missing-ffprobe", []export.Destination{destination}); err != nil {
			t.Fatal(err)
		}
		file, recoveredName, err := recovered.Open(batchID, 0, time.Now())
		if err != nil {
			t.Fatalf("archive was not adopted after restart: %v", err)
		}
		if recoveredName.Name != archiveName {
			t.Fatalf("recovered archive name = %q, want %q", recoveredName.Name, archiveName)
		}
		if err := file.Close(); err != nil {
			t.Fatal(err)
		}
		if _, err := os.Stat(manifestPath); err != nil {
			t.Fatalf("archive manifest was lost before expiry: %v", err)
		}
	}
	recovered.Cleanup(time.Now().Add(2 * time.Hour))
	if _, err := os.Stat(filepath.Join(root, archiveName)); !os.IsNotExist(err) {
		t.Fatal("expired batch archive was not removed")
	}
	if _, err := os.Stat(manifestPath); !os.IsNotExist(err) {
		t.Fatal("expired batch archive manifest was not removed")
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
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Error(err)
		}
	})
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

func TestMediaCatalogPreviewRejectsChangedSourceBeforeCacheLookup(t *testing.T) {
	ctx := t.Context()
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
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Error(err)
		}
	})
	mediaStore, err := store.NewMediaStore(db)
	if err != nil {
		t.Fatal(err)
	}
	catalog := MediaCatalog{Scanner: scanner, Store: mediaStore}
	if err := catalog.Refresh(ctx); err != nil {
		t.Fatal(err)
	}
	id := index.MediaID("camera", "clip.mp4")
	if _, err := catalog.Preview(ctx, projects.PreviewSpec{MediaID: id, WindowMS: 1}); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("changed"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := catalog.Preview(ctx, projects.PreviewSpec{MediaID: id, WindowMS: 1}); !errors.Is(err, index.ErrSourceChanged) {
		t.Fatalf("preview spec after source change = %v, want %v", err, index.ErrSourceChanged)
	}
	if err := catalog.Refresh(ctx); err != nil {
		t.Fatal(err)
	}
	spec, err := catalog.Preview(ctx, projects.PreviewSpec{MediaID: id, WindowMS: 1})
	if err != nil || spec.SizeBytes != int64(len("changed")) {
		t.Fatalf("preview after refresh = %+v, %v", spec, err)
	}
}
