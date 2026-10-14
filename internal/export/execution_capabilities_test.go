package export

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"

	"videocutlist/internal/library/media/index"
	"videocutlist/internal/library/media/probe"
	"videocutlist/internal/projects/model"
)

const capabilityMediaID = "m_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

type capabilityTestCatalog struct{ record index.Record }

func (c *capabilityTestCatalog) Sync(context.Context, string, []index.Record) error { return nil }
func (c *capabilityTestCatalog) Get(context.Context, string) (index.Record, error) {
	return c.record, nil
}
func (c *capabilityTestCatalog) List(context.Context, string, int) (index.Page, error) {
	return index.Page{}, nil
}

type capabilityTestProbe struct{}

func (capabilityTestProbe) ProbeFile(context.Context, *os.File) (probe.Metadata, error) {
	return probe.Metadata{}, nil
}

type capabilityTestLimiter struct {
	mu         sync.Mutex
	acquireErr error
	releases   int
	entered    chan struct{}
}

func (l *capabilityTestLimiter) AcquireProcess() (func(), error) {
	return l.acquire()
}

func (l *capabilityTestLimiter) AcquireProcessContext(ctx context.Context) (func(), error) {
	if l.entered != nil {
		close(l.entered)
		<-ctx.Done()
		return nil, ctx.Err()
	}
	return l.acquire()
}

func (l *capabilityTestLimiter) acquire() (func(), error) {
	if l.acquireErr != nil {
		return nil, l.acquireErr
	}
	return func() {
		l.mu.Lock()
		l.releases++
		l.mu.Unlock()
	}, nil
}

func (l *capabilityTestLimiter) releaseCount() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.releases
}

func capabilityFixture(t *testing.T, sourceName string, limiter *capabilityTestLimiter) (Executor, *capabilityTestCatalog, string, string) {
	t.Helper()
	root := t.TempDir()
	sourcePath := filepath.Join(root, sourceName)
	if err := os.WriteFile(sourcePath, []byte("source media"), 0o600); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(sourcePath)
	if err != nil {
		t.Fatal(err)
	}
	catalog := &capabilityTestCatalog{record: index.Record{
		Media:     index.Media{ID: capabilityMediaID, Name: sourceName, SizeBytes: info.Size(), MtimeNS: info.ModTime().UnixNano()},
		RootAlias: "library", RelativePath: sourceName,
	}}
	scanner, err := index.NewScanner([]index.Root{{Alias: "library", Path: root}}, capabilityTestProbe{})
	if err != nil {
		t.Fatal(err)
	}
	ffprobe := filepath.Join(root, "ffprobe")
	framesMarker := filepath.Join(root, "frames-probed")
	script := `#!/bin/sh
keyframes=0
for arg do
  if [ "$arg" = "-skip_frame" ]; then keyframes=1; fi
  if [ "$arg" = "-show_frames" ]; then
    printf x >> "$VCL_CAPABILITY_FRAMES_MARKER"
    if [ "$keyframes" = 1 ]; then printf '0.000000\n'; exit 0; fi
    if [ "$VCL_CAPABILITY_FRAME_MODE" = "missing" ]; then exit 0; fi
    if [ "$VCL_CAPABILITY_FRAME_MODE" = "invalid" ]; then printf 'not-a-time\n'; exit 0; fi
    printf '0.000000\n0.040000\n'
    exit 0
  fi
done
printf '{"format":{"duration":"2","format_name":"%s"},"streams":[{"index":0,"codec_type":"video","codec_name":"%s","width":1920,"height":1080,"avg_frame_rate":"%s","r_frame_rate":"%s"}]}\n' \
  "${VCL_CAPABILITY_CONTAINER:-matroska,webm}" "${VCL_CAPABILITY_CODEC:-h264}" \
  "${VCL_CAPABILITY_AVG_RATE:-25/1}" "${VCL_CAPABILITY_RATE:-25/1}"
`
	if err := os.WriteFile(ffprobe, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("VCL_CAPABILITY_FRAMES_MARKER", framesMarker)
	t.Setenv("VCL_CAPABILITY_FRAME_MODE", "")
	t.Setenv("VCL_CAPABILITY_CONTAINER", "matroska,webm")
	t.Setenv("VCL_CAPABILITY_CODEC", "h264")
	t.Setenv("VCL_CAPABILITY_AVG_RATE", "25/1")
	t.Setenv("VCL_CAPABILITY_RATE", "25/1")
	service := Service{FFprobePath: ffprobe}
	if limiter != nil {
		service.Capacity = limiter
	}
	return Executor{Scanner: scanner, Media: catalog, Service: service}, catalog, sourcePath, framesMarker
}

func TestExecutorCapabilitiesUsesSharedMetadataEligibilityBeforeFrameScan(t *testing.T) {
	tests := []struct {
		name       string
		sourceName string
		container  string
		codec      string
		avgRate    string
		rate       string
		wantReason string
	}{
		{name: "container", sourceName: "clip.mkv", container: "mp4", codec: "h264", avgRate: "25/1", rate: "25/1", wantReason: "unsupported_container"},
		{name: "extension", sourceName: "clip.mp4", container: "matroska,webm", codec: "h264", avgRate: "25/1", rate: "25/1", wantReason: "unsupported_filename_extension"},
		{name: "codec", sourceName: "clip.mkv", container: "matroska,webm", codec: "hevc", avgRate: "25/1", rate: "25/1", wantReason: "unsupported_video_codec"},
		{name: "frame-rate", sourceName: "clip.mkv", container: "matroska,webm", codec: "h264", avgRate: "24/1", rate: "25/1", wantReason: "non_constant_frame_rate"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			executor, _, _, framesMarker := capabilityFixture(t, test.sourceName, nil)
			t.Setenv("VCL_CAPABILITY_CONTAINER", test.container)
			t.Setenv("VCL_CAPABILITY_CODEC", test.codec)
			t.Setenv("VCL_CAPABILITY_AVG_RATE", test.avgRate)
			t.Setenv("VCL_CAPABILITY_RATE", test.rate)
			capabilities, err := executor.Capabilities(t.Context(), capabilityMediaID)
			if err != nil {
				t.Fatal(err)
			}
			strategy := capabilities.Strategies[0]
			if strategy.Supported || len(strategy.Reasons) != 1 || strategy.Reasons[0] != test.wantReason {
				t.Fatalf("capability = %#v, want unsupported for %s only", strategy, test.wantReason)
			}
			if _, err := os.Stat(framesMarker); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("frame scan marker exists or stat failed: %v", err)
			}
		})
	}
}

func TestExecutorCapabilitiesReservesAndReleasesProcessCapacity(t *testing.T) {
	t.Run("release after success", func(t *testing.T) {
		limiter := &capabilityTestLimiter{}
		executor, _, _, _ := capabilityFixture(t, "clip.mkv", limiter)
		if _, err := executor.Capabilities(t.Context(), capabilityMediaID); err != nil {
			t.Fatal(err)
		}
		if limiter.releaseCount() != 1 {
			t.Fatalf("release count = %d, want 1", limiter.releaseCount())
		}
	})
	t.Run("release after probe error", func(t *testing.T) {
		limiter := &capabilityTestLimiter{}
		executor, _, _, _ := capabilityFixture(t, "clip.mkv", limiter)
		t.Setenv("VCL_CAPABILITY_FRAME_MODE", "invalid")
		if _, err := executor.Capabilities(t.Context(), capabilityMediaID); err == nil {
			t.Fatal("expected invalid timestamp probe error")
		}
		if limiter.releaseCount() != 1 {
			t.Fatalf("release count = %d, want 1", limiter.releaseCount())
		}
	})
	t.Run("reject admission", func(t *testing.T) {
		rejected := errors.New("process capacity rejected")
		limiter := &capabilityTestLimiter{acquireErr: rejected}
		executor, _, _, framesMarker := capabilityFixture(t, "clip.mkv", limiter)
		if _, err := executor.Capabilities(t.Context(), capabilityMediaID); !errors.Is(err, rejected) {
			t.Fatalf("error = %v, want capacity rejection", err)
		}
		if _, err := os.Stat(framesMarker); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("probe ran despite rejection: %v", err)
		}
		if limiter.releaseCount() != 0 {
			t.Fatalf("release count = %d, want 0", limiter.releaseCount())
		}
	})
	t.Run("cancel while waiting", func(t *testing.T) {
		limiter := &capabilityTestLimiter{entered: make(chan struct{})}
		executor, _, _, _ := capabilityFixture(t, "clip.mkv", limiter)
		ctx, cancel := context.WithCancel(t.Context())
		defer cancel()
		result := make(chan error, 1)
		go func() {
			_, err := executor.Capabilities(ctx, capabilityMediaID)
			result <- err
		}()
		<-limiter.entered
		cancel()
		if err := <-result; !errors.Is(err, context.Canceled) {
			t.Fatalf("error = %v, want context cancellation", err)
		}
		if limiter.releaseCount() != 0 {
			t.Fatalf("release count = %d, want 0", limiter.releaseCount())
		}
	})
}

func TestExecutorCapabilitiesCannotAuthorizeChangedSourceForHybridExecution(t *testing.T) {
	executor, catalog, sourcePath, framesMarker := capabilityFixture(t, "clip.mkv", nil)
	before, err := executor.Capabilities(t.Context(), capabilityMediaID)
	if err != nil {
		t.Fatal(err)
	}
	if len(before.Strategies) != 1 || !before.Strategies[0].Supported {
		t.Fatalf("initial capability = %#v, want supported", before)
	}
	previousFrames, err := os.ReadFile(framesMarker)
	if err != nil {
		t.Fatal(err)
	}

	newName := "renamed.mp4"
	newPath := filepath.Join(filepath.Dir(sourcePath), newName)
	if err := os.Rename(sourcePath, newPath); err != nil {
		t.Fatal(err)
	}
	catalog.record.Name = newName
	catalog.record.RelativePath = newName
	t.Setenv("VCL_CAPABILITY_CONTAINER", "mp4")
	t.Setenv("VCL_CAPABILITY_CODEC", "hevc")
	ffmpeg := filepath.Join(filepath.Dir(sourcePath), "ffmpeg")
	if err := os.WriteFile(ffmpeg, []byte("#!/bin/sh\nif [ \"$2\" = \"-muxers\" ]; then printf ' E matroska\\n'; exit 0; fi\nif [ \"$2\" = \"-encoders\" ]; then printf ' V..... libx264\\n A..... aac\\n'; exit 0; fi\nexit 1\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	executor.Service.FFmpegPath = ffmpeg
	item := model.ProjectItem{
		Segments:      []model.Segment{{StartMS: 0, EndMS: 1_000}},
		ExportOptions: model.ExportOptions{Mode: "merge", Selection: "segments", CutStrategy: "hybrid_smart_cut", Container: "mkv"},
	}
	_, err = executor.RunSnapshot(t.Context(), "j_capability_changed", ExportSnapshot{
		Source: SourceSnapshot{MediaID: capabilityMediaID}, Item: item,
	})
	if !errors.Is(err, ErrInvalidRequest) || !errors.Is(err, ErrHybridSmartCutUnsupportedMedia) {
		t.Fatalf("changed source execution error = %v, want invalid request and unsupported hybrid media", err)
	}
	afterFrames, err := os.ReadFile(framesMarker)
	if err != nil {
		t.Fatal(err)
	}
	if string(afterFrames) != string(previousFrames) {
		t.Fatalf("execution probed frame timestamps for unsupported current source: before=%q after=%q", previousFrames, afterFrames)
	}
}

func TestHybridTimestampProbeErrorsKeepUnsupportedClassification(t *testing.T) {
	for _, test := range []struct {
		mode string
		text string
	}{
		{mode: "missing", text: "insufficient video frame timestamps"},
		{mode: "invalid", text: "invalid video frame timestamp"},
	} {
		t.Run(test.mode, func(t *testing.T) {
			executor, _, sourcePath, _ := capabilityFixture(t, "clip.mkv", nil)
			ffmpeg := filepath.Join(filepath.Dir(sourcePath), "ffmpeg")
			if err := os.WriteFile(ffmpeg, []byte("#!/bin/sh\nif [ \"$2\" = \"-muxers\" ]; then printf ' E matroska\\n'; exit 0; fi\nif [ \"$2\" = \"-encoders\" ]; then printf ' V..... libx264\\n A..... aac\\n'; exit 0; fi\nexit 1\n"), 0o700); err != nil {
				t.Fatal(err)
			}
			executor.Service.FFmpegPath = ffmpeg
			t.Setenv("VCL_CAPABILITY_FRAME_MODE", test.mode)
			source, err := os.Open(sourcePath)
			if err != nil {
				t.Fatal(err)
			}
			_, err = executor.Service.Run(t.Context(), source, model.Document{Items: []model.ProjectItem{{Segments: []model.Segment{{StartMS: 0, EndMS: 1_000}}}}}, Request{
				Mode: "merge", Selection: "segments", CutStrategy: "hybrid_smart_cut", Container: "mkv", SourceName: "clip.mkv",
			})
			_ = source.Close()
			if !errors.Is(err, ErrInvalidRequest) || !errors.Is(err, ErrHybridSmartCutUnsupportedMedia) || !strings.Contains(fmt.Sprint(err), test.text) {
				t.Fatalf("error = %v, want prior unsupported classification and %q", err, test.text)
			}
		})
	}
}

func TestHybridCapabilityReasonsCoverMissingAndInvalidMetadata(t *testing.T) {
	if reasons := hybridMetadataCapabilityReasons(probe.Metadata{Container: "matroska,webm"}, "clip.mkv"); !slices.Contains(reasons, "unsupported_video_codec") {
		t.Fatalf("nil-video reasons = %v, want unsupported_video_codec", reasons)
	}
	metadata := probe.Metadata{Container: "matroska,webm", Video: &probe.Video{Codec: "h264", AvgFrameRate: "25/1", FrameRate: "25/1"}}
	if reasons := hybridCapabilityReasons(metadata, "clip.mkv", nil); !slices.Contains(reasons, "non_constant_frame_timestamps") {
		t.Fatalf("missing-timestamp reasons = %v", reasons)
	}
	if reasons := hybridCapabilityReasons(metadata, "clip.mkv", []int64{0, 40, 120}); !slices.Contains(reasons, "non_constant_frame_timestamps") {
		t.Fatalf("invalid-timestamp reasons = %v", reasons)
	}
}
