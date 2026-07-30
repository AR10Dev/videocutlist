package index

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"editapp/internal/media/probe"
)

type fakeProbe struct{}

func (fakeProbe) Probe(context.Context, string) (probe.Metadata, error) {
	return probe.Metadata{DurationMS: 1000, Container: "mp4", Video: &probe.Video{Codec: "h264", Width: 320, Height: 180}}, nil
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
