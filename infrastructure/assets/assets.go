// Package assets generates bounded timeline assets from descriptor-resolved media.
package assets

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"sync"

	"videocutlist/application"
	"videocutlist/domain"
	"videocutlist/infrastructure/media/index"
	"videocutlist/infrastructure/store"
)

const maxWaveformSamples = 4096

type Service struct {
	Scanner    *index.Scanner
	Media      *store.MediaStore
	FFmpegPath string
	CacheDir   string
	MaxBytes   int64
	mu         sync.Mutex
}

func (s *Service) Thumbnails(ctx context.Context, _ domain.Principal, spec application.AssetSpec) (application.AssetResult, error) {
	if err := validate(spec, false); err != nil {
		return application.AssetResult{}, err
	}
	key, err := s.key(ctx, spec, "thumb")
	if err != nil {
		return application.AssetResult{}, err
	}
	data, hit, err := s.cached(key, ".png")
	if err != nil {
		return application.AssetResult{}, err
	}
	if hit {
		return result(data, "image/png", true, spec), nil
	}
	source, _, err := s.Scanner.Open(ctx, s.Media, spec.MediaID)
	if err != nil {
		return application.AssetResult{}, err
	}
	defer source.Close()
	file, ok := source.(*os.File)
	if !ok {
		return application.AssetResult{}, errors.New("media source is not a file")
	}
	fps := float64(spec.Count) / (float64(spec.DurationMS) / 1000)
	args := []string{"-nostdin", "-hide_banner", "-loglevel", "error", "-ss", ms(spec.StartMS), "-i", "/proc/self/fd/3", "-t", ms(spec.DurationMS), "-vf", fmt.Sprintf("fps=%g,scale=%d:-2,tile=%dx1", fps, spec.Width, spec.Count), "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "pipe:1"}
	data, err = run(ctx, s.FFmpegPath, file, args, 8<<20)
	if err != nil {
		return application.AssetResult{}, err
	}
	if err := s.publish(key, ".png", data); err != nil {
		return application.AssetResult{}, err
	}
	return result(data, "image/png", false, spec), nil
}

func (s *Service) Waveform(ctx context.Context, _ domain.Principal, spec application.AssetSpec) (application.AssetResult, error) {
	if err := validate(spec, true); err != nil {
		return application.AssetResult{}, err
	}
	key, err := s.key(ctx, spec, "wave")
	if err != nil {
		return application.AssetResult{}, err
	}
	data, hit, err := s.cached(key, ".json")
	if err != nil {
		return application.AssetResult{}, err
	}
	if hit {
		return waveformResult(data, true, spec)
	}
	source, item, err := s.Scanner.Open(ctx, s.Media, spec.MediaID)
	if err != nil {
		return application.AssetResult{}, err
	}
	defer source.Close()
	if item.Metadata.Audio == nil {
		return application.AssetResult{}, application.ErrNoAudio
	}
	file, ok := source.(*os.File)
	if !ok {
		return application.AssetResult{}, errors.New("media source is not a file")
	}
	args := []string{"-nostdin", "-hide_banner", "-loglevel", "error", "-ss", ms(spec.StartMS), "-i", "/proc/self/fd/3", "-t", ms(spec.DurationMS), "-map", "0:a:0", "-ac", "1", "-ar", fmt.Sprint(min(spec.Samples*2, 48000)), "-f", "f32le", "pipe:1"}
	raw, err := run(ctx, s.FFmpegPath, file, args, 16<<20)
	if err != nil {
		return application.AssetResult{}, err
	}
	var peakBuffer [maxWaveformSamples]float64
	peaks := peakBuffer[:spec.Samples]
	for i := range peaks {
		start := len(raw) * i / spec.Samples
		end := len(raw) * (i + 1) / spec.Samples
		var max float64
		for j := start; j+4 <= end; j += 4 {
			var sample float32
			_ = binary.Read(bytes.NewReader(raw[j:j+4]), binary.LittleEndian, &sample)
			v := math.Abs(float64(sample))
			if v > max {
				max = v
			}
		}
		peaks[i] = minFloat(max, 1)
	}
	data, _ = json.Marshal(map[string]any{"startMs": spec.StartMS, "durationMs": spec.DurationMS, "peaks": peaks})
	if err := s.publish(key, ".json", data); err != nil {
		return application.AssetResult{}, err
	}
	return waveformResult(data, false, spec)
}

func validate(s application.AssetSpec, wave bool) error {
	if s.StartMS < 0 || s.DurationMS < 1 || s.DurationMS > 120000 {
		return errors.New("invalid asset range")
	}
	if wave {
		if s.Samples < 16 || s.Samples > maxWaveformSamples {
			return errors.New("invalid samples")
		}
	} else if s.Count < 1 || s.Count > 32 || s.Width < 80 || s.Width > 320 {
		return errors.New("invalid thumbnail bounds")
	}
	return nil
}
func (s *Service) key(ctx context.Context, spec application.AssetSpec, kind string) (string, error) {
	item, err := s.Media.Get(ctx, spec.MediaID)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256([]byte(fmt.Sprintf("%s:%s:%d:%d:%d:%d:%d:%d", kind, item.ID, item.SizeBytes, item.MtimeNS, spec.StartMS, spec.DurationMS, spec.Count, spec.Width+spec.Samples)))
	return hex.EncodeToString(sum[:]), nil
}
func (s *Service) cached(key, ext string) ([]byte, bool, error) {
	p := filepath.Join(s.CacheDir, "assets", key+ext)
	info, err := os.Stat(p)
	if errors.Is(err, os.ErrNotExist) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	if !info.Mode().IsRegular() || info.Size() < 1 || info.Size() > s.MaxBytes {
		_ = os.Remove(p)
		return nil, false, nil
	}
	b, err := os.ReadFile(p)
	if err != nil {
		return nil, false, err
	}
	if int64(len(b)) != info.Size() {
		return nil, false, nil
	}
	return b, true, nil
}
func (s *Service) publish(key, ext string, b []byte) error {
	if int64(len(b)) > s.MaxBytes {
		return errors.New("asset exceeds cache limit")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	dir := filepath.Join(s.CacheDir, "assets")
	if err := os.MkdirAll(dir, 0750); err != nil {
		return err
	}
	f, err := os.CreateTemp(dir, key+"-*.partial")
	if err != nil {
		return err
	}
	name := f.Name()
	defer os.Remove(name)
	if _, err = f.Write(b); err == nil {
		err = f.Sync()
	}
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	return os.Rename(name, filepath.Join(dir, key+ext))
}

type boundedBuffer struct {
	bytes.Buffer
	max int
}

func (b *boundedBuffer) Write(p []byte) (int, error) {
	if b.Len() < b.max {
		n := b.max - b.Len()
		if len(p) < n {
			n = len(p)
		}
		_, _ = b.Buffer.Write(p[:n])
	}
	return len(p), nil
}
func run(ctx context.Context, path string, file *os.File, args []string, max int) ([]byte, error) {
	if path == "" {
		path = "ffmpeg"
	}
	cmd := exec.CommandContext(ctx, path, args...)
	cmd.ExtraFiles = []*os.File{file}
	var stderr boundedBuffer
	stderr.max = 64 << 10
	cmd.Stderr = &stderr
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("ffmpeg stdout: %w", err)
	}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("ffmpeg start: %w", err)
	}
	out, readErr := io.ReadAll(io.LimitReader(stdout, int64(max)+1))
	overflow := len(out) > max
	if overflow {
		_ = cmd.Process.Kill()
		_ = stdout.Close()
	}
	waitErr := cmd.Wait()
	if readErr != nil {
		return nil, fmt.Errorf("ffmpeg output: %w", readErr)
	}
	if overflow {
		return nil, errors.New("asset output exceeds bound")
	}
	if waitErr != nil {
		return nil, fmt.Errorf("ffmpeg asset: %w: %s", waitErr, stderr.String())
	}
	return out, nil
}
func result(b []byte, ct string, hit bool, s application.AssetSpec) application.AssetResult {
	return application.AssetResult{Reader: io.NopCloser(bytes.NewReader(b)), ContentType: ct, CacheStatus: status(hit), StartMS: s.StartMS, DurationMS: s.DurationMS}
}
func waveformResult(b []byte, hit bool, s application.AssetSpec) (application.AssetResult, error) {
	var v struct {
		StartMS    int64     `json:"startMs"`
		DurationMS int64     `json:"durationMs"`
		Peaks      []float64 `json:"peaks"`
	}
	if err := json.Unmarshal(b, &v); err != nil {
		return application.AssetResult{}, err
	}
	return application.AssetResult{Peaks: v.Peaks, StartMS: v.StartMS, DurationMS: v.DurationMS, CacheStatus: status(hit), ContentType: "application/json"}, nil
}
func status(hit bool) string {
	if hit {
		return "hit"
	}
	return "miss"
}
func ms(v int64) string { return fmt.Sprintf("%d.%03d", v/1000, v%1000) }
func min(v, a int) int {
	if v < a {
		return v
	}
	return a
}
func minFloat(v, a float64) float64 {
	if v < a {
		return v
	}
	return a
}
