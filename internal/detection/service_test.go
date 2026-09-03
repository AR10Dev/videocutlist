package detection

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"videocutlist/internal/library/media/index"
	"videocutlist/internal/library/media/probe"
	"videocutlist/internal/projects"
	"videocutlist/internal/projects/model"
)

type detectionCatalog struct{ record index.Record }

func (c detectionCatalog) Get(context.Context, string) (index.Record, error)  { return c.record, nil }
func (c detectionCatalog) Sync(context.Context, string, []index.Record) error { return nil }
func (c detectionCatalog) List(context.Context, string, int) (index.Page, error) {
	return index.Page{}, nil
}

type detectionProber struct{}

func (detectionProber) ProbeFile(context.Context, *os.File) (probe.Metadata, error) {
	return probe.Metadata{DurationMS: 1000}, nil
}

func TestDetectPassesMediaDescriptorAsChildFD(t *testing.T) {
	dir := t.TempDir()
	mediaPath := filepath.Join(dir, "clip.mp4")
	if err := os.WriteFile(mediaPath, []byte("media"), 0600); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(mediaPath)
	if err != nil {
		t.Fatal(err)
	}
	script := filepath.Join(dir, "ffmpeg.sh")
	if err := os.WriteFile(script, []byte("#!/bin/sh\n[ -r /proc/self/fd/3 ] || exit 9\nprintf 'silence_start: 0.1\\nsilence_end: 0.2\\n' >&2\n"), 0700); err != nil {
		t.Fatal(err)
	}
	scanner, err := index.NewScanner([]index.Root{{Alias: "root", Path: dir}}, detectionProber{})
	if err != nil {
		t.Fatal(err)
	}
	mediaID := index.MediaID("root", "clip.mp4")
	service := Service{Scanner: scanner, Catalog: detectionCatalog{record: index.Record{Media: index.Media{ID: mediaID, SizeBytes: info.Size(), MtimeNS: info.ModTime().UnixNano(), Metadata: probe.Metadata{DurationMS: 1000}}, RootAlias: "root", RelativePath: "clip.mp4"}}, FFmpegPath: script}
	got, err := service.Detect(context.Background(), projects.DetectionRequest{MediaID: mediaID, ProjectRevision: 1, Kind: model.DetectSilence, MinDurationMS: 1})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].StartMS != 100 || got[0].EndMS != 200 {
		t.Fatalf("unexpected detections: %#v", got)
	}
}

func TestParseDetectionCandidatesAreBounded(t *testing.T) {
	r := projects.DetectionRequest{MediaID: "m_test", ProjectID: "p_test", ProjectRevision: 2, Kind: model.DetectSilence}
	got := parse(r, 10000, "[silencedetect] silence_start: 1.2\n[silencedetect] silence_end: 2.5\n")
	if len(got) != 1 || got[0].StartMS != 1200 || got[0].EndMS != 2500 || got[0].ProjectID != r.ProjectID || got[0].Confidence != .9 {
		t.Fatalf("unexpected candidates: %#v", got)
	}
}

func TestParseRejectsUnmatchedAndClampsDuration(t *testing.T) {
	r := projects.DetectionRequest{MediaID: "m_test", ProjectID: "p_test", ProjectRevision: 2, Kind: model.DetectSilence}
	got := parse(r, 1000, "silence_end: 0.5\nsilence_start: 0.8\nsilence_end: 2.0\n")
	if len(got) != 1 || got[0].StartMS != 800 || got[0].EndMS != 1000 {
		t.Fatalf("unexpected bounded candidates: %#v", got)
	}
}
