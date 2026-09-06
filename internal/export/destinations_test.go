package export

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSourceAdjacentDestinationUsesResolvedSourceLocation(t *testing.T) {
	mediaRoot := t.TempDir()
	sourceDir := filepath.Join(mediaRoot, "camera", "day")
	if err := os.MkdirAll(sourceDir, 0o750); err != nil {
		t.Fatal(err)
	}
	sourcePath := filepath.Join(sourceDir, "clip.mkv")
	if err := os.WriteFile(sourcePath, []byte("source"), 0o600); err != nil {
		t.Fatal(err)
	}
	source, err := os.Open(sourcePath)
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()

	prepared, err := prepareDestination(Destination{ID: "beside", Kind: KindSourceAdjacent, MediaRoot: mediaRoot}, source, "clip.mkv", SourceLocation{RootPath: mediaRoot, RelativePath: "camera/day/clip.mkv"})
	if err != nil {
		t.Fatal(err)
	}
	defer prepared.close()
	want := filepath.Join(sourceDir, ".videocutlist-exports")
	if prepared.path != want {
		t.Fatalf("destination = %q, want %q", prepared.path, want)
	}
	if strings.Contains(string(mustJSON(t, Destination{ID: "beside", Kind: KindSourceAdjacent, MediaRoot: mediaRoot}.Public())), mediaRoot) {
		t.Fatal("public destination contains a filesystem path")
	}
	fallback, err := prepareDestination(Destination{ID: "beside", Kind: KindSourceAdjacent, MediaRoot: mediaRoot}, source, "display-only.mkv", SourceLocation{})
	if err != nil {
		t.Fatalf("fallback source path: %v", err)
	}
	defer fallback.close()
	if fallback.path != want {
		t.Fatalf("fallback destination = %q, want %q", fallback.path, want)
	}
}

func TestSourceAdjacentDestinationRejectsTraversalAndEscapingSymlink(t *testing.T) {
	mediaRoot := t.TempDir()
	outside := t.TempDir()
	outsideSource := filepath.Join(outside, "outside.mkv")
	if err := os.WriteFile(outsideSource, []byte("outside"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outsideSource, filepath.Join(mediaRoot, "escape.mkv")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	source, err := os.Open(outsideSource)
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	destination := Destination{ID: "beside", Kind: KindSourceAdjacent, MediaRoot: mediaRoot}
	for _, location := range []SourceLocation{
		{RootPath: mediaRoot, RelativePath: "../outside.mkv"},
		{RootPath: mediaRoot, RelativePath: "escape.mkv"},
	} {
		if _, err := prepareDestination(destination, source, "outside.mkv", location); err == nil {
			t.Fatalf("accepted unsafe source location %#v", location)
		}
	}
}

func TestSourceAdjacentDestinationRejectsMissingSource(t *testing.T) {
	mediaRoot := t.TempDir()
	_, err := prepareDestination(Destination{ID: "beside", Kind: KindSourceAdjacent, MediaRoot: mediaRoot}, nil, "missing.mkv", SourceLocation{RootPath: mediaRoot, RelativePath: "missing.mkv"})
	if err == nil {
		t.Fatal("accepted a missing source")
	}
}

func TestPreparedDestinationPublishesWithoutOverwrite(t *testing.T) {
	directory := t.TempDir()
	prepared, err := prepareDestination(Destination{ID: "download", Kind: KindDownload, Root: directory}, nil, "", SourceLocation{})
	if err != nil {
		t.Fatal(err)
	}
	defer prepared.close()
	temporary, _, temporaryName, err := prepared.createTemp(".temporary-", ".mkv")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := temporary.WriteString("new"); err != nil {
		temporary.Close()
		t.Fatal(err)
	}
	if err := temporary.Close(); err != nil {
		t.Fatal(err)
	}
	defer prepared.remove(temporaryName)
	if err := os.WriteFile(filepath.Join(directory, "existing.mkv"), []byte("old"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := prepared.publish(temporaryName, "existing.mkv"); !errors.Is(err, fs.ErrExist) {
		t.Fatalf("publish collision error = %v", err)
	}
	contents, err := os.ReadFile(filepath.Join(directory, "existing.mkv"))
	if err != nil || string(contents) != "old" {
		t.Fatalf("existing output = %q, err=%v", contents, err)
	}
}

func TestSourceAdjacentDestinationRejectsReadOnlyOutput(t *testing.T) {
	mediaRoot := t.TempDir()
	sourceDir := filepath.Join(mediaRoot, "camera")
	if err := os.MkdirAll(sourceDir, 0o750); err != nil {
		t.Fatal(err)
	}
	sourcePath := filepath.Join(sourceDir, "clip.mkv")
	if err := os.WriteFile(sourcePath, []byte("source"), 0o600); err != nil {
		t.Fatal(err)
	}
	outputDir := filepath.Join(sourceDir, ".videocutlist-exports")
	if err := os.Mkdir(outputDir, 0o555); err != nil {
		t.Fatal(err)
	}
	source, err := os.Open(sourcePath)
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	_, err = prepareDestination(Destination{ID: "beside", Kind: KindSourceAdjacent, MediaRoot: mediaRoot}, source, "clip.mkv", SourceLocation{RootPath: mediaRoot, RelativePath: "camera/clip.mkv"})
	if err == nil {
		t.Fatal("accepted read-only source-adjacent output")
	}
}

func mustJSON(t *testing.T, value any) []byte {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return data
}
