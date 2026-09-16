package export

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"videocutlist/internal/db"
	jobqueue "videocutlist/internal/jobs"
	"videocutlist/internal/library/media/probe"
)

func TestArtifactReconcilePublishesOnlyValidatedOwnedOutput(t *testing.T) {
	dir := t.TempDir()
	ffprobe, fixture := fakeFFprobe(t, probe.Metadata{Container: "matroska", DurationMS: 1000, Streams: sourceStreams().Streams})
	output := filepath.Join(dir, "published.mkv")
	data, err := os.ReadFile(fixture)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(output, data, 0o600); err != nil {
		t.Fatal(err)
	}
	db, err := store.OpenDatabase(context.Background(), filepath.Join(dir, "jobs.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Errorf("close database: %v", err)
		}
	})
	jobs, err := jobqueue.NewJobsStore(db)
	if err != nil {
		t.Fatal(err)
	}
	job := jobqueue.Job{ID: "j_000000000081", BatchID: "b_000000000081", Kind: jobqueue.JobExport, ProjectID: "p_000000000081", ProjectItemID: "i_aaaaaaaaaaaaaaaaaaaaaaaa", RequestJSON: `{}`}
	if _, err := jobs.Create(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	if _, err := jobs.Start(context.Background(), job.ID); err != nil {
		t.Fatal(err)
	}
	manifest, err := WriteManifest(dir, job.ID, KindDownload, []string{"published.mkv"}, time.Now().Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	artifacts := NewArtifactStore()
	if err := artifacts.Reconcile(context.Background(), jobs, ffprobe, []Destination{{Kind: KindDownload, Root: dir}}); err != nil {
		t.Fatal(err)
	}
	stored, err := jobs.Get(context.Background(), job.ID)
	if err != nil || stored.State != jobqueue.JobSucceeded {
		t.Fatalf("job = %#v, err = %v", stored, err)
	}
	if _, _, err := artifacts.Open(job.ID, 0, time.Now()); err != nil {
		t.Fatalf("reconciled artifact unavailable: %v", err)
	}
	if _, err := os.Stat(manifest); !os.IsNotExist(err) {
		t.Fatal("manifest was not removed after reconciliation")
	}
}

func TestArtifactReconcileCleansCancelledPublishedManifestAndPreservesSucceededSibling(t *testing.T) {
	dir := t.TempDir()
	database, err := store.OpenDatabase(context.Background(), filepath.Join(dir, "jobs.db"))
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
	batchID := "b_reconcile_cancelled"
	cancelled := jobqueue.Job{ID: "j_reconcile_cancelled", BatchID: batchID, Kind: jobqueue.JobExport, ProjectID: "p_reconcile_cancelled", ProjectItemID: "i_aaaaaaaaaaaaaaaaaaaaaaaa", RequestJSON: `{}`}
	succeeded := jobqueue.Job{ID: "j_reconcile_succeeded", BatchID: batchID, Kind: jobqueue.JobExport, ProjectID: "p_reconcile_succeeded", ProjectItemID: "i_bbbbbbbbbbbbbbbbbbbbbbbb", RequestJSON: `{}`}
	for _, job := range []jobqueue.Job{cancelled, succeeded} {
		if _, err := jobs.Create(context.Background(), job); err != nil {
			t.Fatal(err)
		}
		if _, err := jobs.Start(context.Background(), job.ID); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := jobs.Cancel(context.Background(), cancelled.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := jobs.Succeed(context.Background(), succeeded.ID, `{"outputName":"succeeded.mkv"}`); err != nil {
		t.Fatal(err)
	}
	cancelledOutput := filepath.Join(dir, "cancelled.mkv")
	succeededOutput := filepath.Join(dir, "succeeded.mkv")
	for _, path := range []string{cancelledOutput, succeededOutput} {
		if err := os.WriteFile(path, []byte("published output"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	cancelledManifest, err := WriteManifest(dir, cancelled.ID, KindDownload, []string{"cancelled.mkv"}, time.Now().Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	succeededManifest, err := WriteManifest(dir, succeeded.ID, KindDownload, []string{"succeeded.mkv"}, time.Now().Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	// A fresh store models restart after publication but before the runner's
	// durable success transition/manifest cleanup completed.
	artifacts := NewArtifactStore()
	if err := artifacts.Reconcile(context.Background(), jobs, "missing-ffprobe", []Destination{{Kind: KindDownload, Root: dir}}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(cancelledOutput); !os.IsNotExist(err) {
		t.Fatal("cancelled published output was not cleaned")
	}
	if _, err := os.Stat(cancelledManifest); !os.IsNotExist(err) {
		t.Fatal("cancelled manifest was not removed")
	}
	if _, err := os.Stat(succeededOutput); err != nil {
		t.Fatalf("succeeded sibling output was removed: %v", err)
	}
	if _, err := os.Stat(succeededManifest); err != nil {
		t.Fatalf("succeeded sibling manifest was removed: %v", err)
	}
	storedCancelled, err := jobs.Get(context.Background(), cancelled.ID)
	if err != nil || storedCancelled.State != jobqueue.JobCancelled {
		t.Fatalf("cancelled job = %#v, err = %v", storedCancelled, err)
	}
	storedSucceeded, err := jobs.Get(context.Background(), succeeded.ID)
	if err != nil || storedSucceeded.State != jobqueue.JobSucceeded || !storedSucceeded.ResultJSON.Valid {
		t.Fatalf("succeeded job = %#v, err = %v", storedSucceeded, err)
	}
}

func TestArtifactReconcileCleansInvalidOwnedOutputOnly(t *testing.T) {
	dir := t.TempDir()
	db, err := store.OpenDatabase(context.Background(), filepath.Join(dir, "jobs.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Errorf("close database: %v", err)
		}
	})
	jobs, err := jobqueue.NewJobsStore(db)
	if err != nil {
		t.Fatal(err)
	}
	job := jobqueue.Job{ID: "j_000000000082", BatchID: "b_000000000082", Kind: jobqueue.JobExport, ProjectID: "p_000000000082", ProjectItemID: "i_aaaaaaaaaaaaaaaaaaaaaaaa", RequestJSON: `{}`}
	if _, err := jobs.Create(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	if _, err := jobs.Start(context.Background(), job.ID); err != nil {
		t.Fatal(err)
	}
	output := filepath.Join(dir, "incomplete.mkv")
	if err := os.WriteFile(output, []byte("not media"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := WriteManifest(dir, job.ID, KindDownload, []string{"incomplete.mkv"}, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	unrelated := filepath.Join(dir, "unrelated.mkv")
	if err := os.WriteFile(unrelated, []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	artifacts := NewArtifactStore()
	if err := artifacts.Reconcile(context.Background(), jobs, filepath.Join(dir, "missing-ffprobe"), []Destination{{Kind: KindDownload, Root: dir}}); err != nil {
		t.Fatal(err)
	}
	stored, err := jobs.Get(context.Background(), job.ID)
	if err != nil || stored.State != jobqueue.JobRunning {
		t.Fatalf("invalid artifact changed job: %#v, %v", stored, err)
	}
	if _, err := os.Stat(output); !os.IsNotExist(err) {
		t.Fatal("invalid owned output was not cleaned")
	}
	if _, err := os.Stat(unrelated); err != nil {
		t.Fatalf("unrelated file was touched: %v", err)
	}
}

func TestArtifactStoreOpenRejectsSymlinkOutsideRoot(t *testing.T) {
	dir := t.TempDir()
	target := "/etc/passwd"
	path := filepath.Join(dir, "download.mkv")
	if err := os.Symlink(target, path); err != nil {
		t.Fatal(err)
	}
	store := NewArtifactStore()
	store.Put("job", []Artifact{{Path: path, Name: "download.mkv", Kind: KindDownload, Expires: time.Now().Add(time.Hour)}})
	// Identity revalidation is paired with root checking, so a replaced or
	// redirected pathname cannot be served from outside the configured root.
	if _, _, err := store.Open("job", 0, time.Now()); err == nil {
		t.Fatal("symlinked artifact outside root was opened")
	}
	if err := VerifyArtifact(context.Background(), "missing-ffprobe", path); !errors.Is(err, ErrOutputUnavailable) {
		t.Fatalf("verify symlink error = %v", err)
	}
}

func TestArtifactStoreRemoveRollsBackPublishedFiles(t *testing.T) {
	path := filepath.Join(t.TempDir(), "published.mkv")
	if err := os.WriteFile(path, []byte("output"), 0o600); err != nil {
		t.Fatal(err)
	}
	store := NewArtifactStore()
	store.Put("job", []Artifact{{Path: path, Kind: KindDownload}})
	if err := store.Remove("job"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("published artifact was not removed")
	}
}

func TestArtifactStoreRemoveRetainsManifestAfterCleanupFailure(t *testing.T) {
	directory := t.TempDir()
	outputPath := filepath.Join(directory, "published.mkv")
	if err := os.Mkdir(outputPath, 0o700); err != nil {
		t.Fatal(err)
	}
	manifestPath, err := WriteManifest(directory, "j_cleanup_failure", KindDownload, []string{"published.mkv"}, time.Now().Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	artifacts := NewArtifactStore()
	artifacts.Put("j_cleanup_failure", []Artifact{{Path: outputPath, Name: "published.mkv", Kind: KindDownload}})
	artifacts.RegisterManifest("j_cleanup_failure", manifestPath)
	if err := artifacts.Remove("j_cleanup_failure"); err == nil {
		t.Fatal("directory artifact cleanup unexpectedly succeeded")
	}
	if _, err := os.Stat(manifestPath); err != nil {
		t.Fatalf("cleanup evidence was lost: %v", err)
	}
	if err := os.Remove(outputPath); err != nil {
		t.Fatal(err)
	}
	if err := artifacts.Remove("j_cleanup_failure"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(manifestPath); !os.IsNotExist(err) {
		t.Fatal("manifest remained after cleanup retry")
	}
}

func TestArtifactStoreJobIsolationAndExpiry(t *testing.T) {
	dir := t.TempDir()
	first := filepath.Join(dir, "one.mkv")
	second := filepath.Join(dir, "two.mkv")
	if err := os.WriteFile(first, []byte("one"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(second, []byte("two"), 0o600); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	store := NewArtifactStore()
	store.Put("job-one", []Artifact{{Path: first, Name: "one.mkv", Kind: KindDownload, Expires: now.Add(time.Hour)}})
	store.Put("job-two", []Artifact{{Path: second, Name: "two.mkv", Kind: KindDownload, Expires: now.Add(time.Hour)}})
	var wg sync.WaitGroup
	for _, job := range []string{"job-one", "job-two"} {
		wg.Go(func() {
			file, artifact, err := store.Open(job, 0, now)
			if err != nil {
				t.Error(err)
				return
			}
			defer func() {
				if err := file.Close(); err != nil {
					t.Errorf("close artifact: %v", err)
				}
			}()
			if artifact.Name != job[len("job-"):]+".mkv" {
				t.Errorf("job %s opened %s", job, artifact.Name)
			}
		})
	}
	wg.Wait()
	if _, _, err := store.Open("job-one", 0, now.Add(2*time.Hour)); err == nil {
		t.Fatal("expired output opened")
	}
	store.Cleanup(now.Add(2 * time.Hour))
	if _, err := os.Stat(first); !os.IsNotExist(err) {
		t.Fatal("expired artifact was not cleaned")
	}
}
