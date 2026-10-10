package adapters

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"videocutlist/internal/db"
	"videocutlist/internal/library/media/index"
	"videocutlist/internal/library/media/probe"
	previewdomain "videocutlist/internal/preview"
	"videocutlist/internal/preview/ffmpeg"
)

type adapterProbe struct{}

func (adapterProbe) ProbeFile(context.Context, *os.File) (probe.Metadata, error) {
	return probe.Metadata{}, nil
}

func TestPreviewRunnerRejectsChangedSourceForOldSpec(t *testing.T) {
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
	if err := scanner.Refresh(ctx, mediaStore); err != nil {
		t.Fatal(err)
	}
	id := index.MediaID("camera", "clip.mp4")
	record, err := mediaStore.Get(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	spec := previewdomain.TranscodeSpec{MediaID: id, SizeBytes: record.SizeBytes, MtimeNS: record.MtimeNS, DurationMS: 1}
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
