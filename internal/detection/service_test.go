package detection

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

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
	if err := os.WriteFile(script, []byte("#!/bin/sh\n[ -r /proc/self/fd/3 ] || exit 9\nhas_vn=false\nfor arg in \"$@\"; do\n  case \"$arg\" in\n    -vn) has_vn=true ;;\n    -vf) exit 10 ;;\n  esac\ndone\n[ \"$has_vn\" = true ] || exit 11\nprintf 'silence_start: 0.1\\nsilence_end: 0.2\\n' >&2\n"), 0700); err != nil {
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
	if len(got) != 1 || got[0].StartMS != 1200 || got[0].EndMS != 2500 || got[0].ProjectID != r.ProjectID {
		t.Fatalf("unexpected candidates: %#v", got)
	}
}

func TestParseSceneChangesAsPoints(t *testing.T) {
	r := projects.DetectionRequest{MediaID: "m_test", ProjectID: "p_test", ProjectRevision: 2, Kind: model.DetectScene}
	got := parse(r, 3000, "[showinfo] pts_time:1.250\\n")
	if len(got) != 1 {
		t.Fatalf("unexpected scene points: %#v", got)
	}
	data, err := json.Marshal(got[0])
	if err != nil {
		t.Fatal(err)
	}
	var payload map[string]any
	if err := json.Unmarshal(data, &payload); err != nil {
		t.Fatal(err)
	}
	if payload["pointMs"] != float64(1250) {
		t.Fatalf("scene point payload = %s", data)
	}
	if _, ok := payload["startMs"]; ok {
		t.Fatalf("scene point has range start: %s", data)
	}
	if _, ok := payload["endMs"]; ok {
		t.Fatalf("scene point has range end: %s", data)
	}
}

func TestDetectionSlotsDefaultToOne(t *testing.T) {
	service := Service{}
	release, err := service.acquireSlot(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Millisecond)
	defer cancel()
	secondRelease, err := service.acquireSlot(ctx)
	if secondRelease != nil {
		secondRelease()
	}
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("second detection slot error = %v", err)
	}
}

func TestParseRejectsUnmatchedAndClampsDuration(t *testing.T) {
	r := projects.DetectionRequest{MediaID: "m_test", ProjectID: "p_test", ProjectRevision: 2, Kind: model.DetectSilence}
	got := parse(r, 1000, "silence_end: 0.5\nsilence_start: 0.8\nsilence_end: 2.0\n")
	if len(got) != 1 || got[0].StartMS != 800 || got[0].EndMS != 1000 {
		t.Fatalf("unexpected bounded candidates: %#v", got)
	}
}
