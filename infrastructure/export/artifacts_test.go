package export

import (
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

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
