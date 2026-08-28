package export

import (
	"context"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"videocutlist/infrastructure/media/probe"
	"videocutlist/infrastructure/store"
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
	defer db.Close()
	jobs, err := store.NewJobsStore(db)
	if err != nil {
		t.Fatal(err)
	}
	job := store.Job{ID: "j_000000000081", BatchID: "b_000000000081", Kind: store.JobExport, ProjectID: "p_000000000081", ProjectItemID: "i_aaaaaaaaaaaaaaaaaaaaaaaa", RequestJSON: `{}`}
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
	if err != nil || stored.State != store.JobSucceeded {
		t.Fatalf("job = %#v, err = %v", stored, err)
	}
	if _, _, err := artifacts.Open(job.ID, 0, time.Now()); err != nil {
		t.Fatalf("reconciled artifact unavailable: %v", err)
	}
	if _, err := os.Stat(manifest); !os.IsNotExist(err) {
		t.Fatal("manifest was not removed after reconciliation")
	}
}

func TestArtifactReconcileCleansInvalidOwnedOutputOnly(t *testing.T) {
	dir := t.TempDir()
	db, err := store.OpenDatabase(context.Background(), filepath.Join(dir, "jobs.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	jobs, err := store.NewJobsStore(db)
	if err != nil {
		t.Fatal(err)
	}
	job := store.Job{ID: "j_000000000082", BatchID: "b_000000000082", Kind: store.JobExport, ProjectID: "p_000000000082", ProjectItemID: "i_aaaaaaaaaaaaaaaaaaaaaaaa", RequestJSON: `{}`}
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
	if err != nil || stored.State != store.JobRunning {
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
}

func TestArtifactStoreRemoveRollsBackPublishedFiles(t *testing.T) {
	path := filepath.Join(t.TempDir(), "published.mkv")
	if err := os.WriteFile(path, []byte("output"), 0o600); err != nil {
		t.Fatal(err)
	}
	store := NewArtifactStore()
	store.Put("job", []Artifact{{Path: path, Kind: KindDownload}})
	store.Remove("job")
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("published artifact was not removed")
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
		wg.Add(1)
		go func(id string) {
			defer wg.Done()
			file, artifact, err := store.Open(id, 0, now)
			if err != nil {
				t.Error(err)
				return
			}
			defer file.Close()
			if artifact.Name != id[len("job-"):]+".mkv" {
				t.Errorf("job %s opened %s", id, artifact.Name)
			}
		}(job)
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
