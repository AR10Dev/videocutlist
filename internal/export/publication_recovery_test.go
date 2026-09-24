package export

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	store "videocutlist/internal/db"
	jobqueue "videocutlist/internal/jobs"
	"videocutlist/internal/library/media/probe"
)

func TestCollisionPublicationRecoveryPreservesExternalFile(t *testing.T) {
	for _, published := range []bool{false, true} {
		name := "before-publication"
		if published {
			name = "after-publication"
		}
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			database, err := store.OpenDatabase(t.Context(), filepath.Join(t.TempDir(), "jobs.db"))
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
			job := jobqueue.Job{ID: "j_collision001", BatchID: "b_collision001", Kind: jobqueue.JobExport, ProjectID: "p_collision001", ProjectItemID: "i_collision001", RequestJSON: `{}`}
			if _, err = jobs.Create(t.Context(), job); err != nil {
				t.Fatal(err)
			}
			if _, err = jobs.Start(t.Context(), job.ID); err != nil {
				t.Fatal(err)
			}
			ffprobe, fixture := fakeFFprobe(t, probe.Metadata{Container: "matroska", DurationMS: 1000, Streams: sourceStreams().Streams})
			data, err := os.ReadFile(fixture)
			if err != nil {
				t.Fatal(err)
			}
			temporary := filepath.Join(dir, "temporary.mkv")
			if err = os.WriteFile(temporary, data, 0600); err != nil {
				t.Fatal(err)
			}
			collision := filepath.Join(dir, "output.mkv")
			if err = os.WriteFile(collision, []byte("unrelated"), 0600); err != nil {
				t.Fatal(err)
			}
			root, err := os.OpenRoot(dir)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() {
				if err := root.Close(); err != nil {
					t.Error(err)
				}
			})
			names := []string{"output.mkv"}
			owners, err := manifestOwnersForPaths(names, []string{temporary})
			if err != nil {
				t.Fatal(err)
			}
			expiry := time.Now().Add(time.Hour)
			if _, err = writeManifestAtWithOwners(root, dir, job.ID, KindDownload, "download", names, owners, expiry, "mkv"); err != nil {
				t.Fatal(err)
			}
			if published {
				names[0] = "output-1.mkv"
				owners[0].Name = names[0]
				if _, err = writeManifestAtWithOwners(root, dir, job.ID, KindDownload, "download", names, owners, expiry, "mkv"); err != nil {
					t.Fatal(err)
				}
				if err = os.Link(temporary, filepath.Join(dir, names[0])); err != nil {
					t.Fatal(err)
				}
			}
			destinations := []Destination{{ID: "download", Kind: KindDownload, Root: dir}}
			for restart := range 2 {
				artifacts := NewArtifactStore()
				if err = artifacts.Reconcile(t.Context(), jobs, ffprobe, destinations); err != nil {
					t.Fatal(err)
				}
				preserved, err := os.ReadFile(collision)
				if err != nil || string(preserved) != "unrelated" {
					t.Fatalf("collision file damaged: %q, %v", preserved, err)
				}
				stored, err := jobs.Get(t.Context(), job.ID)
				if err != nil {
					t.Fatal(err)
				}
				if published {
					if stored.State != jobqueue.JobSucceeded {
						t.Fatalf("published output not recovered: %s", stored.State)
					}
					file, artifact, err := artifacts.Open(job.ID, 0, time.Now())
					if err != nil {
						t.Fatal(err)
					}
					if err := file.Close(); err != nil {
						t.Fatal(err)
					}
					if artifact.Name != "output-1.mkv" {
						t.Fatalf("wrong recovered output: %s", artifact.Name)
					}
					if restart == 1 {
						artifacts.Cleanup(expiry.Add(time.Second))
						if _, err = os.Stat(filepath.Join(dir, names[0])); !os.IsNotExist(err) {
							t.Fatalf("expired artifact survived second restart: %v", err)
						}
					}
				} else if stored.State == jobqueue.JobSucceeded {
					t.Fatal("unpublished collision adopted as success")
				}
			}
		})
	}
}

func TestPublicationRollbackPreservesReplacement(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "output.mkv")
	if err := os.WriteFile(path, []byte("owned"), 0600); err != nil {
		t.Fatal(err)
	}
	owners, err := manifestOwnersForPaths([]string{"output.mkv"}, []string{path})
	if err != nil {
		t.Fatal(err)
	}
	// Keep the original inode alive so replacement cannot recycle its number.
	if err = os.Rename(path, filepath.Join(dir, "original.mkv")); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(path, []byte("external"), 0600); err != nil {
		t.Fatal(err)
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := root.Close(); err != nil {
			t.Error(err)
		}
	})
	preparedDestination{root: root}.removeOwned(owners[0])
	data, err := os.ReadFile(path)
	if err != nil || string(data) != "external" {
		t.Fatalf("rollback removed replacement: %q %v", data, err)
	}
}

func TestArtifactStoreCancellationPreservesReplacedOutput(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "output.mkv")
	if err := os.WriteFile(path, []byte("owned"), 0600); err != nil {
		t.Fatal(err)
	}
	manifest, err := WriteManifestWithOwners(dir, "j_replacement01", KindDownload, []string{"output.mkv"}, []string{path}, time.Now().Add(time.Hour), "mkv")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(path, filepath.Join(dir, "original.mkv")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("external"), 0600); err != nil {
		t.Fatal(err)
	}
	artifacts := NewArtifactStore()
	artifacts.Put("j_replacement01", []Artifact{{Path: path, Name: "output.mkv", Kind: KindDownload, Expires: time.Now().Add(time.Hour)}})
	artifacts.RegisterManifest("j_replacement01", manifest)
	if err := artifacts.Remove("j_replacement01"); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil || string(data) != "external" {
		t.Fatalf("cancellation removed replacement: %q %v", data, err)
	}
}
