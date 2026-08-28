package index

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"

	"videocutlist/infrastructure/media/probe"
)

func TestFolderIDIsOpaqueAndStable(t *testing.T) {
	id := FolderID("library", "clips/2024")
	if id != FolderID("library", "clips/2024") || len(id) != 45 || id[:2] != "f_" {
		t.Fatalf("unexpected folder id: %q", id)
	}
	if id == "clips/2024" || id == FolderID("library", "other") {
		t.Fatal("folder IDs must not expose paths or collide")
	}
}

type fakeProbe struct{}

func (fakeProbe) ProbeFile(context.Context, *os.File) (probe.Metadata, error) {
	return probe.Metadata{DurationMS: 1000, Container: "mp4", Video: &probe.Video{Codec: "h264", Width: 320, Height: 180}}, nil
}

func TestScanEnforcesConfiguredFileLimit(t *testing.T) {
	root := t.TempDir()
	for _, name := range []string{"one.mp4", "two.mp4"} {
		if err := os.WriteFile(filepath.Join(root, name), []byte(name), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	scanner, err := NewScannerWithLimits([]Root{{Alias: "library", Path: root}}, fakeProbe{}, ScanLimits{MaxFiles: 1, MaxDepth: 2})
	if err != nil {
		t.Fatal(err)
	}
	_, err = scanner.Scan(context.Background(), "library")
	if !errors.Is(err, ErrScanLimit) {
		t.Fatalf("scan error = %v, want ErrScanLimit", err)
	}
}

func TestScanHonorsCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	scanner, err := NewScannerWithLimits([]Root{{Alias: "library", Path: t.TempDir()}}, fakeProbe{}, ScanLimits{MaxFiles: 1, MaxDepth: 1})
	if err != nil {
		t.Fatal(err)
	}
	_, err = scanner.Scan(ctx, "library")
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("scan error = %v, want context.Canceled", err)
	}
}

type failingProbe struct{}

func (failingProbe) ProbeFile(context.Context, *os.File) (probe.Metadata, error) {
	return probe.Metadata{}, errors.New("probe failed")
}

func TestRefreshKeepsSuccessfulRootsWhenAnotherRootFails(t *testing.T) {
	good := t.TempDir()
	if err := os.WriteFile(filepath.Join(good, "clip.mp4"), []byte("clip"), 0o600); err != nil {
		t.Fatal(err)
	}
	catalog := &memoryCatalog{}
	scanner, err := NewScanner([]Root{
		{Alias: "good", Path: good},
		{Alias: "missing", Path: filepath.Join(t.TempDir(), "missing")},
	}, fakeProbe{})
	if err != nil {
		t.Fatal(err)
	}
	if err := scanner.Refresh(context.Background(), catalog); err == nil {
		t.Fatal("refresh succeeded despite failed root")
	}
	if len(catalog.records) != 1 || catalog.records[MediaID("good", "clip.mp4")].RootAlias != "good" {
		t.Fatalf("successful root was not published: %#v", catalog.records)
	}
}

func TestRefreshKeepsPreviousCatalogOnProbeFailure(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "clip.mp4"), []byte("clip"), 0o600); err != nil {
		t.Fatal(err)
	}
	catalog := &memoryCatalog{}
	scanner, err := NewScanner([]Root{{Alias: "library", Path: root}}, fakeProbe{})
	if err != nil {
		t.Fatal(err)
	}
	if err := scanner.Refresh(context.Background(), catalog); err != nil {
		t.Fatal(err)
	}
	scanner.prober = failingProbe{}
	if err := scanner.Refresh(context.Background(), catalog); err == nil {
		t.Fatal("refresh succeeded despite probe failure")
	}
	if len(catalog.records) != 1 {
		t.Fatalf("previous catalog was replaced: %#v", catalog.records)
	}
}

func TestRefreshReportsAnUnavailableConfiguredRoot(t *testing.T) {
	scanner, err := NewScanner([]Root{{Alias: "camera", Path: filepath.Join(t.TempDir(), "missing")}}, fakeProbe{})
	if err != nil {
		t.Fatal(err)
	}
	if err := scanner.Refresh(context.Background(), &memoryCatalog{}); err == nil {
		t.Fatal("refresh succeeded")
	}
}

func TestOpenRejectsSymlinkReplacementAfterIndexing(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "clip.mp4")
	if err := os.WriteFile(path, []byte("inside"), 0o600); err != nil {
		t.Fatal(err)
	}
	external := filepath.Join(t.TempDir(), "outside.mp4")
	if err := os.WriteFile(external, []byte("outside"), 0o600); err != nil {
		t.Fatal(err)
	}
	scanner, err := NewScanner([]Root{{Alias: "camera", Path: root}}, fakeProbe{})
	if err != nil {
		t.Fatal(err)
	}
	catalog := &memoryCatalog{}
	if err := scanner.Refresh(context.Background(), catalog); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(external, path); err != nil {
		t.Fatal(err)
	}
	for id := range catalog.records {
		file, _, err := scanner.Open(context.Background(), catalog, id)
		if file != nil {
			_ = file.Close()
		}
		if err == nil {
			t.Fatal("opened symlink escape")
		}
		return
	}
	t.Fatal("expected indexed media")
}

func TestOpenKeepsOriginalRootAcrossPathReplacement(t *testing.T) {
	parent := t.TempDir()
	root := filepath.Join(parent, "media")
	if err := os.Mkdir(root, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "clip.mp4"), []byte("inside"), 0o600); err != nil {
		t.Fatal(err)
	}
	scanner, err := NewScanner([]Root{{Alias: "camera", Path: root}}, fakeProbe{})
	if err != nil {
		t.Fatal(err)
	}
	catalog := &memoryCatalog{}
	if err := scanner.Refresh(context.Background(), catalog); err != nil {
		t.Fatal(err)
	}
	oldRoot := filepath.Join(parent, "media-old")
	if err := os.Rename(root, oldRoot); err != nil {
		t.Fatal(err)
	}
	external := filepath.Join(parent, "external")
	if err := os.Mkdir(external, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(external, "clip.mp4"), []byte("outside"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(external, root); err != nil {
		t.Fatal(err)
	}
	for id := range catalog.records {
		file, _, err := scanner.Open(context.Background(), catalog, id)
		if err != nil {
			t.Fatal(err)
		}
		data, err := io.ReadAll(file)
		_ = file.Close()
		if err != nil || string(data) != "inside" {
			t.Fatalf("read %q, %v", data, err)
		}
		return
	}
	t.Fatal("expected indexed media")
}

type memoryCatalog struct{ records map[string]Record }

func (m *memoryCatalog) Sync(_ context.Context, alias string, records []Record) error {
	if m.records == nil {
		m.records = map[string]Record{}
	}
	for id, record := range m.records {
		if record.RootAlias == alias {
			delete(m.records, id)
		}
	}
	for _, record := range records {
		m.records[record.ID] = record
	}
	return nil
}

func (m *memoryCatalog) RemoveRoot(_ context.Context, alias string) error {
	for id, record := range m.records {
		if record.RootAlias == alias {
			delete(m.records, id)
		}
	}
	return nil
}

func (m *memoryCatalog) Get(_ context.Context, id string) (Record, error) {
	record, ok := m.records[id]
	if !ok {
		return Record{}, ErrNotFound
	}
	return record, nil
}

func (m *memoryCatalog) List(_ context.Context, cursor string, limit int) (Page, error) {
	return Page{}, nil
}

func TestReconfigureValidatesAllowlistAndRemovesRecords(t *testing.T) {
	parent := t.TempDir()
	oldRoot := filepath.Join(parent, "old")
	newRoot := filepath.Join(parent, "new")
	if err := os.Mkdir(oldRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(newRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	scanner, err := NewScanner([]Root{{Alias: "old", Path: oldRoot}}, fakeProbe{})
	if err != nil {
		t.Fatal(err)
	}
	catalog := &memoryCatalog{records: map[string]Record{"id": {RootAlias: "old"}}}
	if err := scanner.Reconfigure(context.Background(), []Root{{Alias: "new", Path: newRoot}}, []string{parent}, catalog); err != nil {
		t.Fatal(err)
	}
	if len(catalog.records) != 0 {
		t.Fatal("removed root records remain available")
	}
	if _, err := scanner.Scan(context.Background(), "old"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("old root scan error = %v", err)
	}
	if err := scanner.Reconfigure(context.Background(), []Root{{Alias: "escape", Path: filepath.Join(t.TempDir(), "other")}}, []string{parent}, catalog); err == nil {
		t.Fatal("allowlist escape accepted")
	}
}

func TestReconfigureRejectsDuplicateAndRelativeRoots(t *testing.T) {
	scanner, err := NewScanner([]Root{{Alias: "one", Path: t.TempDir()}}, fakeProbe{})
	if err != nil {
		t.Fatal(err)
	}
	for _, roots := range [][]Root{
		{{Alias: "dup", Path: t.TempDir()}, {Alias: "dup", Path: t.TempDir()}},
		{{Alias: "relative", Path: "media"}},
	} {
		if err := scanner.Reconfigure(context.Background(), roots, nil, nil); err == nil {
			t.Fatal("invalid roots accepted")
		}
	}
}

func TestScanSkipsSymlinkEscapeAndUsesOpaqueID(t *testing.T) {
	root := t.TempDir()
	inside := filepath.Join(root, "inside.mp4")
	if err := os.WriteFile(inside, []byte("inside"), 0o600); err != nil {
		t.Fatal(err)
	}
	external := filepath.Join(t.TempDir(), "outside.mp4")
	if err := os.WriteFile(external, []byte("outside"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(external, filepath.Join(root, "escape.mp4")); err != nil {
		t.Fatal(err)
	}
	scanner, err := NewScanner([]Root{{Alias: "camera", Path: root}}, fakeProbe{})
	if err != nil {
		t.Fatal(err)
	}
	records, err := scanner.Scan(context.Background(), "camera")
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != 1 || records[0].ID != MediaID("camera", "inside.mp4") || records[0].RelativePath != "inside.mp4" {
		t.Fatalf("unexpected records: %#v", records)
	}
	if records[0].ID == "inside.mp4" {
		t.Fatal("media ID exposed a path")
	}
}

func TestOpenRejectsChangedSource(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "clip.mp4")
	if err := os.WriteFile(path, []byte("old"), 0o600); err != nil {
		t.Fatal(err)
	}
	scanner, err := NewScanner([]Root{{Alias: "camera", Path: root}}, fakeProbe{})
	if err != nil {
		t.Fatal(err)
	}
	catalog := &memoryCatalog{}
	if err := scanner.Refresh(context.Background(), catalog); err != nil {
		t.Fatal(err)
	}
	for _, record := range catalog.records {
		if err := os.WriteFile(path, []byte("replaced"), 0o600); err != nil {
			t.Fatal(err)
		}
		file, _, err := scanner.Open(context.Background(), catalog, record.ID)
		if file != nil {
			file.Close()
		}
		if !errors.Is(err, ErrSourceChanged) {
			t.Fatalf("got %v, want source changed", err)
		}
		return
	}
	t.Fatal("expected indexed media")
}
