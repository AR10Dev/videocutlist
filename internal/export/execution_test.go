package export

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
	testsupport "videocutlist/internal/testsupport"

	store "videocutlist/internal/db"
	jobqueue "videocutlist/internal/jobs/model"
	"videocutlist/internal/projects/model"
	settingsmodel "videocutlist/internal/settings/model"
)

type failingCloser struct{ err error }

func (c failingCloser) Close() error { return c.err }

func TestExportSnapshotJSONContract(t *testing.T) {
	snapshot := ExportSnapshot{
		ProjectRevision: 3, MediaLabel: "clip.mkv",
		Item:   model.ProjectItem{ID: "i_aaaaaaaaaaaaaaaaaaaaaaaa", MediaID: "m_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", Segments: []model.Segment{}, ExportOptions: model.ExportOptions{Mode: "merge", Selection: "segments", StreamIndexes: []int{0}, CutStrategy: "precise_reencode", Container: "mkv", DestinationID: "download", FilenameTemplate: "clip.{ext}"}},
		Source: SourceSnapshot{MediaID: "m_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", RootID: "root", ETag: "etag", SizeBytes: 10, DurationMS: 20},
	}
	encoded, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	const want = `{"projectRevision":3,"mediaLabel":"clip.mkv","item":{"id":"i_aaaaaaaaaaaaaaaaaaaaaaaa","mediaId":"m_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","segments":[],"exportOptions":{"mode":"merge","selection":"segments","streamIndexes":[0],"cutStrategy":"precise_reencode","container":"mkv","destinationId":"download","filenameTemplate":"clip.{ext}"}},"source":{"mediaId":"m_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","rootId":"root","etag":"etag","sizeBytes":10,"durationMs":20}}`
	var actual, expected any
	if err := json.Unmarshal(encoded, &actual); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(want), &expected); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(actual, expected) {
		t.Fatalf("snapshot JSON = %s, want %s", encoded, want)
	}
}

func TestPreflightRequestPreservesPersistedDefaultsAndNullableOverrides(t *testing.T) {
	stored := model.ExportOptions{Mode: "separate", Selection: "gaps", CutStrategy: "precise_reencode", Container: "mkv", DestinationID: "archive", FilenameTemplate: "saved-{segment}.{ext}", StreamIndexes: []int{1}}
	request := requestForOptions(stored.WithExportDefaults())
	if request.Mode != stored.Mode || request.Selection != stored.Selection || request.CutStrategy != stored.CutStrategy || request.DestinationID != stored.DestinationID || request.FilenameTemplate != stored.FilenameTemplate || len(request.StreamIndexes) != 1 || request.StreamIndexes[0] != 1 {
		t.Fatalf("persisted preflight request = %#v", request)
	}
	override := requestForOptions(model.ExportOptions{Mode: "merge"})
	if override.Mode != "merge" || override.Selection != "" || override.Container != "" {
		t.Fatalf("nullable override defaults were changed before export preflight: %#v", override)
	}
	stored.StreamIndexes[0] = 9
	if request.StreamIndexes[0] != 1 {
		t.Fatal("preflight request retained mutable persisted stream indexes")
	}
}

func TestRuntimeSettingsAdaptExportDestinations(t *testing.T) {
	state := settingsmodel.NewRuntimeSettingsState(settingsmodel.RuntimeSettings{Destinations: []settingsmodel.RuntimeDestination{{ID: "archive", Label: "Archive", Description: "saved output", Kind: KindArchive, Root: "/exports", Retention: "2h", MediaRoot: "/media"}}})
	executor := Executor{Service: Service{OutputDir: "/default"}, Settings: state}
	service := executor.service()
	if len(service.Destinations) != 1 || service.Destinations[0].ID != "archive" || service.Destinations[0].Root != "/exports" || service.Destinations[0].Retention != 2*time.Hour || service.Destinations[0].MediaRoot != "/media" {
		t.Fatalf("adapted export destinations = %#v", service.Destinations)
	}
}

func TestSnapshotSourceClosePreservesPublishedResult(t *testing.T) {
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

func TestExportDownloadEnforcesDurableLifecycle(t *testing.T) {
	ctx := t.Context()
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
	jobs, err := testsupport.NewJobsStore(db)
	if err != nil {
		t.Fatal(err)
	}
	executor := Executor{Jobs: jobs, Service: Service{OutputDir: root, Artifacts: NewArtifactStore()}}
	create := func(t *testing.T, id string, result Result) {
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
	create(t, "j_download_ok0", Result{OutputName: "export.mkv", RetainUntil: fresh, DestinationKind: KindDownload})
	file, name, err := executor.Download(ctx, "j_download_ok0", 0)
	if err != nil || name != "export.mkv" {
		t.Fatalf("Download() = (%q, %v), want public download", name, err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}

	create(t, "j_download_expired0", Result{OutputName: "export.mkv", RetainUntil: time.Now().Add(-time.Hour), DestinationKind: KindDownload})
	create(t, "j_download_archive0", Result{OutputName: "export.mkv", RetainUntil: fresh, DestinationKind: KindArchive})
	create(t, "j_download_source0", Result{OutputName: "export.mkv", RetainUntil: fresh, DestinationKind: KindSourceAdjacent})
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
	jobs, err := testsupport.NewJobsStore(database)
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
	manifest, err := WriteManifest(root, jobID, KindDownload, []string{outputName}, expires)
	if err != nil {
		t.Fatal(err)
	}
	destination := Destination{ID: "browser", Kind: KindDownload, Root: root}
	artifacts := NewArtifactStore()
	if err := artifacts.Reconcile(ctx, jobs, ffprobe, []Destination{destination}); err != nil {
		t.Fatal(err)
	}
	executor := Executor{Jobs: jobs, Service: Service{OutputDir: t.TempDir(), Destinations: []Destination{destination}, Artifacts: artifacts}}
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
	var result Result
	if err := json.Unmarshal([]byte(recovered.ResultJSON.String), &result); err != nil {
		t.Fatal(err)
	}
	if !result.RetainUntil.Equal(expires) || result.DestinationID != destination.ID || result.DestinationKind != KindDownload {
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
	if _, err := WriteManifest(root, expiredID, KindDownload, []string{expiredName}, time.Now().UTC().Add(-time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err := artifacts.Reconcile(ctx, jobs, ffprobe, []Destination{destination}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := executor.Download(ctx, expiredID, 0); err == nil {
		t.Fatal("expired recovered output was downloadable")
	}
}
