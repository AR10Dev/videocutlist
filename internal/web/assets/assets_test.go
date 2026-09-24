package assets

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"image"
	"image/png"
	"io"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	store "videocutlist/internal/db"
	"videocutlist/internal/library/media/index"
	"videocutlist/internal/library/media/probe"
	"videocutlist/internal/projects"
)

type rejectingProcessLimiter struct{}

func (rejectingProcessLimiter) AcquireProcess() (func(), error) {
	return nil, errors.New("capacity exhausted")
}

func TestServiceRunUsesSharedProcessCapacity(t *testing.T) {
	source, err := os.Open(os.DevNull)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := source.Close(); err != nil {
			t.Error(err)
		}
	})
	_, err = (&Service{Capacity: rejectingProcessLimiter{}}).run(context.Background(), source, nil, 1)
	if err == nil || err.Error() != "capacity exhausted" {
		t.Fatalf("run error = %v", err)
	}
}

func TestPublishDoesNotPublishAfterCancellationWhileLocked(t *testing.T) {
	dir := t.TempDir()
	s := &Service{CacheDir: dir, MaxBytes: 1024}
	ctx, cancel := context.WithCancel(context.Background())
	s.mu.Lock()
	done := make(chan error, 1)
	go func() { done <- s.publish(ctx, "key", ".png", []byte("png")) }()
	cancel()
	s.mu.Unlock()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("publish error = %v, want cancellation", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "assets", "key.png")); !os.IsNotExist(err) {
		t.Fatalf("cancelled publish created cache artifact: %v", err)
	}
}

func TestPublishRemovesAssetWhenCancelledDuringRename(t *testing.T) {
	dir := t.TempDir()
	s := &Service{CacheDir: dir, MaxBytes: 1024}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	originalRename := renameAsset
	renameAsset = func(old, new string) error {
		cancel()
		return os.Rename(old, new)
	}
	defer func() { renameAsset = originalRename }()

	if err := s.publish(ctx, "key", ".png", []byte("png")); !errors.Is(err, context.Canceled) {
		t.Fatalf("publish error = %v, want cancellation", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "assets", "key.png")); !os.IsNotExist(err) {
		t.Fatalf("cancelled publish created cache artifact: %v", err)
	}
}

func TestValidateRejectsExcessiveWaveformSamples(t *testing.T) {
	if err := validate(projects.AssetSpec{DurationMS: 1, Samples: maxWaveformSamples + 1}, true); err == nil {
		t.Fatal("validate accepted excessive waveform samples")
	}
}

func TestRunRejectsOversizedOutput(t *testing.T) {
	if _, err := exec.LookPath("sh"); err != nil {
		t.Skip("sh unavailable")
	}
	source, err := os.Open(os.DevNull)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := source.Close(); err != nil {
			t.Error(err)
		}
	})
	_, err = run(context.Background(), "sh", source, []string{"-c", "dd if=/dev/zero bs=1024 count=2 2>/dev/null"}, 1024)
	if err == nil || err.Error() != "asset output exceeds bound" {
		t.Fatalf("run error = %v, want oversized output error", err)
	}
}

func TestRunUsesDescriptorAndProducesPNG(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg unavailable")
	}
	source, err := os.CreateTemp(t.TempDir(), "fixture-*.mp4")
	if err != nil {
		t.Fatal(err)
	}
	if err := source.Close(); err != nil {
		t.Error(err)
	}
	// Generate a deterministic fixture, then reopen it as the descriptor supplied to run.
	if err := exec.Command("ffmpeg", "-y", "-f", "lavfi", "-i", "color=c=blue:s=64x64:d=1", "-pix_fmt", "yuv420p", source.Name()).Run(); err != nil {
		t.Fatal(err)
	}
	source, err = os.Open(source.Name())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := source.Close(); err != nil {
			t.Error(err)
		}
	})
	data, err := run(context.Background(), "ffmpeg", source, []string{"-nostdin", "-hide_banner", "-loglevel", "error", "-i", "/proc/self/fd/3", "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "pipe:1"}, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	if len(data) < 8 || string(data[:8]) != "\x89PNG\r\n\x1a\n" {
		t.Fatalf("not PNG output: %d bytes", len(data))
	}
}

type assetProbe struct{}

func (assetProbe) ProbeFile(context.Context, *os.File) (probe.Metadata, error) {
	return probe.Metadata{DurationMS: 1000, Container: "mp4", Video: &probe.Video{Codec: "h264", Width: 80, Height: 80}, Audio: &probe.Audio{Codec: "aac"}}, nil
}

func assetFixture(t *testing.T, output []byte) (*Service, projects.AssetSpec) {
	t.Helper()
	db, err := store.OpenDatabase(t.Context(), filepath.Join(t.TempDir(), "assets.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	media, _ := store.NewMediaStore(db)
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "clip.mp4"), []byte("fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	scanner, err := index.NewScanner([]index.Root{{Alias: "library", Path: root}}, assetProbe{})
	if err != nil {
		t.Fatal(err)
	}
	if err := scanner.Refresh(t.Context(), media); err != nil {
		t.Fatal(err)
	}
	command := filepath.Join(t.TempDir(), "ffmpeg")
	if err := os.WriteFile(command, []byte("#!/bin/sh\ncat \"$0.output\"\n"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(command+".output", output, 0600); err != nil {
		t.Fatal(err)
	}
	return &Service{Scanner: scanner, Media: media, FFmpegPath: command, CacheDir: t.TempDir(), MaxBytes: 1 << 20}, projects.AssetSpec{MediaID: index.MediaID("library", "clip.mp4"), DurationMS: 1000, Count: 1, Width: 80, Samples: 16}
}

func TestWaveformPartitionsFloat32Samples(t *testing.T) {
	raw := make([]byte, 17*4)
	for i := range 17 {
		binary.LittleEndian.PutUint32(raw[i*4:], math.Float32bits(-float32(i+1)/32))
	}
	s, spec := assetFixture(t, raw)
	result, err := s.Waveform(t.Context(), spec)
	if err != nil {
		t.Fatal(err)
	}
	for i, peak := range result.Peaks {
		want := float64(i+1) / 32
		if i == 15 {
			want = 17.0 / 32
		}
		if peak != want {
			t.Fatalf("peak %d = %v, want %v", i, peak, want)
		}
	}
	for _, raw := range [][]byte{nil, {0}, {0, 0, 0, 0, 0}, {0, 0, 128, 127}} {
		if _, err := waveformPeaks(raw, 16); err == nil {
			t.Fatalf("accepted malformed samples: %v", raw)
		}
	}
}

func thumbnailPNG(t *testing.T) []byte {
	t.Helper()
	var data bytes.Buffer
	if err := png.Encode(&data, image.NewRGBA(image.Rect(0, 0, 80, 80))); err != nil {
		t.Fatal(err)
	}
	return data.Bytes()
}

func TestThumbnailsRejectsInvalidSuccessfulOutput(t *testing.T) {
	valid := thumbnailPNG(t)
	for _, data := range [][]byte{nil, []byte("not a PNG"), valid[:len(valid)-8]} {
		s, spec := assetFixture(t, data)
		if _, err := s.Thumbnails(t.Context(), spec); err == nil {
			t.Fatal("accepted invalid PNG")
		}
		files, err := filepath.Glob(filepath.Join(s.CacheDir, "assets", "*"))
		if err != nil || len(files) != 0 {
			t.Fatalf("published invalid PNG: %v, %v", files, err)
		}
	}
}

func TestThumbnailsRegeneratesCorruptCacheAndHonorsLiveLimit(t *testing.T) {
	valid := thumbnailPNG(t)
	s, spec := assetFixture(t, valid)
	key, err := s.key(t.Context(), spec, "thumb")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.publish(t.Context(), key, ".png", []byte("corrupt")); err != nil {
		t.Fatal(err)
	}
	result, err := s.Thumbnails(t.Context(), spec)
	if err != nil {
		t.Fatal(err)
	}
	data, err := io.ReadAll(result.Reader)
	if err := result.Reader.Close(); err != nil {
		t.Fatal(err)
	}
	if err != nil || !bytes.Equal(data, valid) || result.CacheStatus != "miss" {
		t.Fatalf("regenerated = %s, %v", result.CacheStatus, err)
	}
	if err := s.SetMaxBytes(1); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Thumbnails(t.Context(), spec); err == nil {
		t.Fatal("new cache limit was not enforced")
	}
	if err := s.SetMaxBytes(1 << 20); err != nil {
		t.Fatal(err)
	}
	result, err = s.Thumbnails(t.Context(), spec)
	if err != nil {
		t.Fatal(err)
	}
	if err := result.Reader.Close(); err != nil {
		t.Fatal(err)
	}
	if result.CacheStatus != "miss" {
		t.Fatal("oversized cache entry was not removed")
	}
}

func TestWaveformRegeneratesCacheThatDoesNotMatchRequest(t *testing.T) {
	for _, test := range []struct {
		name     string
		document func([]float64) any
	}{
		{
			name: "missing range field",
			document: func(peaks []float64) any {
				return map[string]any{"durationMs": 1000, "peaks": peaks}
			},
		},
		{
			name: "wrong requested range",
			document: func(peaks []float64) any {
				return map[string]any{"startMs": 0, "durationMs": 999, "peaks": peaks}
			},
		},
		{
			name: "wrong peak count",
			document: func([]float64) any {
				return map[string]any{"startMs": 0, "durationMs": 1000, "peaks": []float64{0.5}}
			},
		},
		{
			name: "out of range peak",
			document: func(peaks []float64) any {
				peaks[0] = 1.1
				return map[string]any{"startMs": 0, "durationMs": 1000, "peaks": peaks}
			},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			raw := make([]byte, 16*4)
			s, spec := assetFixture(t, raw)
			peaks := make([]float64, spec.Samples)
			for i := range peaks {
				peaks[i] = 0.5
			}
			document, err := json.Marshal(test.document(peaks))
			if err != nil {
				t.Fatal(err)
			}
			key, err := s.key(t.Context(), spec, "wave-v2")
			if err != nil {
				t.Fatal(err)
			}
			if err := s.publish(t.Context(), key, ".json", document); err != nil {
				t.Fatal(err)
			}
			result, err := s.Waveform(t.Context(), spec)
			if err != nil {
				t.Fatal(err)
			}
			if result.CacheStatus != "miss" || len(result.Peaks) != spec.Samples {
				t.Fatalf("regenerated waveform = %#v", result)
			}
			cached, err := os.ReadFile(filepath.Join(s.CacheDir, "assets", key+".json"))
			if err != nil {
				t.Fatal(err)
			}
			if _, err := waveformResult(cached, true, spec); err != nil {
				t.Fatalf("regenerated cache remains invalid: %v", err)
			}
		})
	}
}

func TestThumbnailsRejectsPNGCacheOverFixedCompressedSize(t *testing.T) {
	var data bytes.Buffer
	if err := (&png.Encoder{CompressionLevel: png.NoCompression}).Encode(&data, image.NewGray(image.Rect(0, 0, 3000, 3000))); err != nil {
		t.Fatal(err)
	}
	if len(data.Bytes()) <= maxPNGBytes {
		t.Fatalf("test PNG is %d bytes, want more than %d", data.Len(), maxPNGBytes)
	}
	if err := validatePNG(data.Bytes()); err == nil {
		t.Fatal("accepted oversized PNG")
	}
	s, spec := assetFixture(t, thumbnailPNG(t))
	s.MaxBytes = 32 << 20
	key, err := s.key(t.Context(), spec, "thumb")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.publish(t.Context(), key, ".png", data.Bytes()); err != nil {
		t.Fatal(err)
	}
	result, err := s.Thumbnails(t.Context(), spec)
	if err != nil {
		t.Fatal(err)
	}
	if err := result.Reader.Close(); err != nil {
		t.Fatal(err)
	}
	if result.CacheStatus != "miss" {
		t.Fatal("oversized PNG cache entry was served")
	}
}
