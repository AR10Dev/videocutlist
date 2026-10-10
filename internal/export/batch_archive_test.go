package export

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"testing"
	"time"
	testsupport "videocutlist/internal/testsupport"

	store "videocutlist/internal/db"
	jobqueue "videocutlist/internal/jobs/model"
)

func TestBatchArchiveDuplicateEntryNamesAreUnique(t *testing.T) {
	used := make(map[string]int)
	for _, name := range []string{"clip.mkv", "clip.mkv", "clip-2.mkv", "clip.mkv"} {
		got := uniqueBatchArchiveName(name, used)
		if used[got] != 1 {
			t.Fatalf("uniqueBatchArchiveName(%q) = %q, not marked unique", name, got)
		}
	}
	if got := uniqueBatchArchiveName("clip.mkv", used); got != "clip-4.mkv" {
		t.Fatalf("duplicate name = %q, want clip-4.mkv", got)
	}
}

func TestBatchArchiveOutputNamesRejectPaths(t *testing.T) {
	for _, name := range []string{"../clip.mkv", "..", ".", "nested/clip.mkv", "clip\n.mkv"} {
		outputs, ok := resultOutputNames(Result{OutputName: name})
		if ok || outputs != nil {
			t.Fatalf("resultOutputNames(%q) accepted unsafe archive name", name)
		}
	}
}

func TestBatchArchivePublishesValidatedArchive(t *testing.T) {
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
	jobs, err := testsupport.NewJobsStore(database)
	if err != nil {
		t.Fatal(err)
	}
	batchID := "b_aggregate1234"
	for id, name := range map[string]string{"j_aggregateone": "first.mkv", "j_aggregatetwo": "second.mkv"} {
		resultJSON, err := json.Marshal(Result{
			OutputName: name, SizeBytes: int64(len(name)), RetainUntil: time.Now().Add(time.Hour), DestinationKind: KindDownload,
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
	service := Service{OutputDir: root, Artifacts: NewArtifactStore()}
	executor := BatchArchiveService{Jobs: jobs, Service: service, Downloads: Executor{Jobs: jobs, Service: service}}
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
	destination := Destination{ID: "download", Kind: KindDownload, Root: root}
	manifestPath := filepath.Join(root, ".videocutlist-export-"+batchID+".json")
	var recovered *ArtifactStore
	for range 2 {
		recovered = NewArtifactStore()
		if err := recovered.Reconcile(ctx, jobs, "missing-ffprobe", []Destination{destination}); err != nil {
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

// acquireBatchArchiveLock calls Done only after a nonblocking flock attempt reports contention.
type lockWaitObserver struct {
	context.Context
	waiting chan struct{}
	once    sync.Once
}

func (c *lockWaitObserver) Done() <-chan struct{} {
	c.once.Do(func() { close(c.waiting) })
	return c.Context.Done()
}

func TestConcurrentBatchDownloadsShareOneOwnedArchive(t *testing.T) {
	ctx := t.Context()
	root := t.TempDir()
	const batchID = "b_concurrent_zip"
	expected := map[string][]byte{
		"first.mkv":  bytes.Repeat([]byte("first output"), 1<<17),
		"second.mkv": bytes.Repeat([]byte("second output"), 1<<17),
	}
	for name, content := range expected {
		if err := os.WriteFile(filepath.Join(root, name), content, 0o600); err != nil {
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
	jobs, err := testsupport.NewJobsStore(database)
	if err != nil {
		t.Fatal(err)
	}
	for id, name := range map[string]string{"j_concurrent_one": "first.mkv", "j_concurrent_two": "second.mkv"} {
		result, err := json.Marshal(Result{OutputName: name, RetainUntil: time.Now().Add(time.Hour), DestinationKind: KindDownload})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := jobs.Create(ctx, jobqueue.Job{ID: id, BatchID: batchID, Kind: jobqueue.JobExport, ProjectID: "project", ProjectItemID: id, RequestJSON: `{}`}); err != nil {
			t.Fatal(err)
		}
		if _, err := jobs.Start(ctx, id); err != nil {
			t.Fatal(err)
		}
		if _, err := jobs.Succeed(ctx, id, string(result)); err != nil {
			t.Fatal(err)
		}
	}
	if runtime.GOOS != "linux" && runtime.GOOS != "darwin" {
		t.Skip("batch archive publication requires a process-shared filesystem lock")
	}
	unlock, err := acquireBatchArchiveLock(ctx, filepath.Join(root, ".videocutlist-batches.lock"))
	if err != nil {
		t.Fatal(err)
	}
	var releaseLockOnce sync.Once
	releaseLock := func() { releaseLockOnce.Do(unlock) }
	firstService := Service{OutputDir: root, Artifacts: NewArtifactStore()}
	secondService := Service{OutputDir: root, Artifacts: NewArtifactStore()}
	first := BatchArchiveService{Jobs: jobs, Service: firstService, Downloads: Executor{Jobs: jobs, Service: firstService}}
	second := BatchArchiveService{Jobs: jobs, Service: secondService, Downloads: Executor{Jobs: jobs, Service: secondService}}
	cancelCtx, cancel := context.WithCancel(ctx)
	observer := &lockWaitObserver{Context: cancelCtx, waiting: make(chan struct{})}
	waiterResult := make(chan error, 1)
	waiterFinished := make(chan struct{})
	outputs := []batchArchiveOutput{{jobID: "j_concurrent_one", name: "first.mkv"}, {jobID: "j_concurrent_two", name: "second.mkv"}}
	go func() {
		defer close(waiterFinished)
		file, _, err := first.downloadBatchWithLock(observer, batchID, root, outputs, time.Now().Add(time.Hour))
		if file != nil {
			_ = file.Close()
		}
		waiterResult <- err
	}()
	defer func() {
		cancel()
		releaseLock()
		select {
		case <-waiterFinished:
		case <-time.After(time.Second):
			t.Error("lock waiter did not finish after cancellation and release")
		}
	}()
	select {
	case <-observer.waiting:
	case <-time.After(time.Second):
		t.Fatal("lock waiter did not reach the contended retry loop")
	}
	cancel()
	select {
	case err := <-waiterResult:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("cancelled lock waiter = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("cancelled lock waiter did not return")
	}
	releaseLock()

	type download struct {
		name string
		data []byte
		err  error
	}
	const callers = 8
	results := make(chan download, callers)
	start := make(chan struct{})
	var group sync.WaitGroup
	for i := range callers {
		executor := first
		if i%2 != 0 {
			executor = second
		}
		group.Go(func() {
			<-start
			file, name, err := executor.DownloadBatch(ctx, batchID)
			if err != nil {
				results <- download{err: err}
				return
			}
			data, readErr := io.ReadAll(file)
			closeErr := file.Close()
			results <- download{name: name, data: data, err: errors.Join(readErr, closeErr)}
		})
	}
	close(start)
	group.Wait()
	close(results)
	var archiveName string
	for result := range results {
		if result.err != nil {
			t.Fatal(result.err)
		}
		if archiveName == "" {
			archiveName = result.name
		} else if result.name != archiveName {
			t.Fatalf("competing archives %q and %q", archiveName, result.name)
		}
		archive, err := zip.NewReader(bytes.NewReader(result.data), int64(len(result.data)))
		if err != nil {
			t.Fatalf("downloaded ZIP invalid: %v", err)
		}
		if len(archive.File) != len(expected) {
			t.Fatalf("downloaded ZIP has %d entries, want %d", len(archive.File), len(expected))
		}
		for _, entry := range archive.File {
			reader, err := entry.Open()
			if err != nil {
				t.Fatal(err)
			}
			data, readErr := io.ReadAll(reader)
			closeErr := reader.Close()
			if readErr != nil || closeErr != nil || !bytes.Equal(data, expected[entry.Name]) {
				t.Fatalf("ZIP entry %q differs from export: read=%v close=%v", entry.Name, readErr, closeErr)
			}
		}
	}
	archives, err := filepath.Glob(filepath.Join(root, "videocutlist-clips-*.zip"))
	if err != nil || len(archives) != 1 || filepath.Base(archives[0]) != archiveName {
		t.Fatalf("published archives = %v: %v", archives, err)
	}
	partials, err := filepath.Glob(filepath.Join(root, ".videocutlist-batch-*.zip"))
	if err != nil || len(partials) != 0 {
		t.Fatalf("orphan temporary archives = %v: %v", partials, err)
	}
	recovered := NewArtifactStore()
	if err := recovered.Reconcile(ctx, jobs, "missing-ffprobe", []Destination{{ID: "download", Kind: KindDownload, Root: root}}); err != nil {
		t.Fatal(err)
	}
	recoveredFile, artifact, err := recovered.Open(batchID, 0, time.Now())
	if err != nil || artifact.Name != archiveName {
		t.Fatalf("durable archive name=%q err=%v; want %q", artifact.Name, err, archiveName)
	}
	if err := recoveredFile.Close(); err != nil {
		t.Fatal(err)
	}
}
