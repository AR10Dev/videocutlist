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
	"image/png"
	"io"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"sync"

	"videocutlist/internal/db"
	"videocutlist/internal/library/media/index"
	"videocutlist/internal/projects"
)

const (
	maxWaveformSamples = 4096
	maxPNGBytes        = 8 << 20
)

type ProcessLimiter interface {
	AcquireProcess() (func(), error)
}

type Service struct {
	Scanner    *index.Scanner
	Media      *store.MediaStore
	FFmpegPath string
	CacheDir   string
	MaxBytes   int64
	Capacity   ProcessLimiter
	mu         sync.Mutex
}

var renameAsset = os.Rename

func (s *Service) Thumbnails(ctx context.Context, spec projects.AssetSpec) (output projects.AssetResult, err error) {
	if err := validate(spec, false); err != nil {
		return projects.AssetResult{}, err
	}
	key, err := s.key(ctx, spec, "thumb")
	if err != nil {
		return projects.AssetResult{}, err
	}
	data, hit, err := s.cached(key, ".png", validatePNG)
	if err != nil {
		return projects.AssetResult{}, err
	}
	if hit {
		return result(data, "image/png", true, spec), nil
	}
	source, _, err := s.Scanner.Open(ctx, s.Media, spec.MediaID)
	if err != nil {
		return projects.AssetResult{}, err
	}
	defer func() {
		if closeErr := source.Close(); closeErr != nil {
			err = errors.Join(err, fmt.Errorf("close thumbnail source: %w", closeErr))
		}
	}()
	file, ok := source.(*os.File)
	if !ok {
		return projects.AssetResult{}, errors.New("media source is not a file")
	}
	fps := float64(spec.Count) / (float64(spec.DurationMS) / 1000)
	args := []string{"-nostdin", "-hide_banner", "-loglevel", "error", "-ss", ms(spec.StartMS), "-i", "/proc/self/fd/3", "-t", ms(spec.DurationMS), "-vf", fmt.Sprintf("fps=%g,scale=%d:-2,tile=%dx1", fps, spec.Width, spec.Count), "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "pipe:1"}
	data, err = s.run(ctx, file, args, maxPNGBytes)
	if err != nil {
		return projects.AssetResult{}, err
	}
	if err := validatePNG(data); err != nil {
		return projects.AssetResult{}, err
	}
	if err := s.publish(ctx, key, ".png", data); err != nil {
		return projects.AssetResult{}, err
	}
	return result(data, "image/png", false, spec), nil
}

func (s *Service) Waveform(ctx context.Context, spec projects.AssetSpec) (output projects.AssetResult, err error) {
	if err := validate(spec, true); err != nil {
		return projects.AssetResult{}, err
	}
	key, err := s.key(ctx, spec, "wave-v2")
	if err != nil {
		return projects.AssetResult{}, err
	}
	data, hit, err := s.cached(key, ".json", func(data []byte) error {
		_, err := waveformResult(data, true, spec)
		return err
	})
	if err != nil {
		return projects.AssetResult{}, err
	}
	if hit {
		return waveformResult(data, true, spec)
	}
	source, item, err := s.Scanner.Open(ctx, s.Media, spec.MediaID)
	if err != nil {
		return projects.AssetResult{}, err
	}
	defer func() {
		if closeErr := source.Close(); closeErr != nil {
			err = errors.Join(err, fmt.Errorf("close waveform source: %w", closeErr))
		}
	}()
	if item.Metadata.Audio == nil {
		return projects.AssetResult{}, projects.ErrNoAudio
	}
	file, ok := source.(*os.File)
	if !ok {
		return projects.AssetResult{}, errors.New("media source is not a file")
	}
	args := []string{"-nostdin", "-hide_banner", "-loglevel", "error", "-ss", ms(spec.StartMS), "-i", "/proc/self/fd/3", "-t", ms(spec.DurationMS), "-map", "0:a:0", "-ac", "1", "-ar", fmt.Sprint(min(spec.Samples*2, 48000)), "-f", "f32le", "pipe:1"}
	raw, err := s.run(ctx, file, args, 16<<20)
	if err != nil {
		return projects.AssetResult{}, err
	}
	peaks, err := waveformPeaks(raw, spec.Samples)
	if err != nil {
		return projects.AssetResult{}, err
	}
	data, _ = json.Marshal(map[string]any{"startMs": spec.StartMS, "durationMs": spec.DurationMS, "peaks": peaks})
	if err := s.publish(ctx, key, ".json", data); err != nil {
		return projects.AssetResult{}, err
	}
	return waveformResult(data, false, spec)
}

func waveformPeaks(raw []byte, buckets int) ([]float64, error) {
	if len(raw) == 0 || len(raw)%4 != 0 {
		return nil, errors.New("invalid float32 waveform output")
	}
	peaks := make([]float64, buckets)
	samples := len(raw) / 4
	for i := range peaks {
		start, end := samples*i/buckets, samples*(i+1)/buckets
		for j := start; j < end; j++ {
			sample := math.Abs(float64(math.Float32frombits(binary.LittleEndian.Uint32(raw[j*4:]))))
			if math.IsNaN(sample) || math.IsInf(sample, 0) {
				return nil, errors.New("non-finite waveform sample")
			}
			peaks[i] = min(max(peaks[i], sample), 1)
		}
	}
	return peaks, nil
}

func validatePNG(data []byte) error {
	if len(data) > maxPNGBytes {
		return errors.New("thumbnail PNG exceeds compressed-size limit")
	}
	config, err := png.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return fmt.Errorf("invalid thumbnail PNG: %w", err)
	}
	// Bound decoded memory as well as compressed subprocess output.
	if int64(config.Width)*int64(config.Height) > 16<<20 {
		return errors.New("thumbnail PNG exceeds pixel limit")
	}
	if _, err := png.Decode(bytes.NewReader(data)); err != nil {
		return fmt.Errorf("invalid thumbnail PNG: %w", err)
	}
	return nil
}

func validate(s projects.AssetSpec, wave bool) error {
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
func (s *Service) key(ctx context.Context, spec projects.AssetSpec, kind string) (string, error) {
	item, err := s.Media.Get(ctx, spec.MediaID)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256([]byte(fmt.Sprintf("%s:%s:%d:%d:%d:%d:%d:%d", kind, item.ID, item.SizeBytes, item.MtimeNS, spec.StartMS, spec.DurationMS, spec.Count, spec.Width+spec.Samples)))
	return hex.EncodeToString(sum[:]), nil
}
func (s *Service) cached(key, ext string, validate func([]byte) error) ([]byte, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p := filepath.Join(s.CacheDir, "assets", key+ext)
	info, err := os.Stat(p)
	if errors.Is(err, os.ErrNotExist) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	if !info.Mode().IsRegular() || info.Size() < 1 || info.Size() > s.MaxBytes || ext == ".png" && info.Size() > maxPNGBytes {
		_ = os.Remove(p)
		return nil, false, nil
	}
	b, err := os.ReadFile(p)
	if err != nil {
		return nil, false, err
	}
	if int64(len(b)) != info.Size() || validate != nil && validate(b) != nil {
		_ = os.Remove(p)
		return nil, false, nil
	}
	return b, true, nil
}
func (s *Service) publish(ctx context.Context, key, ext string, b []byte) (err error) {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if int64(len(b)) > s.MaxBytes {
		return errors.New("asset exceeds cache limit")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	dir := filepath.Join(s.CacheDir, "assets")
	if err := os.MkdirAll(dir, 0750); err != nil {
		return err
	}
	f, err := os.CreateTemp(dir, key+"-*.partial")
	if err != nil {
		return err
	}
	name := f.Name()
	published := false
	defer func() {
		// Once renamed, the temporary name is gone; cleanup is best-effort and
		// must not turn a successful atomic publish into an error.
		if removeErr := os.Remove(name); removeErr != nil && !errors.Is(removeErr, os.ErrNotExist) && !published {
			err = errors.Join(err, fmt.Errorf("remove temporary asset: %w", removeErr))
		}
	}()
	if _, err = f.Write(b); err == nil {
		err = f.Sync()
	}
	if closeErr := f.Close(); err == nil {
		err = closeErr
	} else if closeErr != nil {
		err = errors.Join(err, closeErr)
	}
	if err != nil {
		return err
	}
	final := filepath.Join(dir, key+ext)
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := renameAsset(name, final); err != nil {
		return err
	}
	published = true
	if err := ctx.Err(); err != nil {
		return errors.Join(err, os.Remove(final))
	}
	return nil
}

// SetMaxBytes applies the per-artifact limit to subsequent reads and publishes.
func (s *Service) SetMaxBytes(maxBytes int64) error {
	if maxBytes < 1 {
		return errors.New("asset cache limit must be positive")
	}
	s.mu.Lock()
	s.MaxBytes = maxBytes
	s.mu.Unlock()
	return nil
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
func (s *Service) run(ctx context.Context, file *os.File, args []string, max int) ([]byte, error) {
	if s.Capacity != nil {
		release, err := projects.AcquireProcess(ctx, s.Capacity)
		if err != nil {
			return nil, err
		}
		defer release()
	}
	return run(ctx, s.FFmpegPath, file, args, max)
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
func result(b []byte, ct string, hit bool, s projects.AssetSpec) projects.AssetResult {
	return projects.AssetResult{Reader: io.NopCloser(bytes.NewReader(b)), ContentType: ct, CacheStatus: status(hit), StartMS: s.StartMS, DurationMS: s.DurationMS}
}
func waveformResult(b []byte, hit bool, s projects.AssetSpec) (projects.AssetResult, error) {
	var v struct {
		StartMS    *int64    `json:"startMs"`
		DurationMS *int64    `json:"durationMs"`
		Peaks      []float64 `json:"peaks"`
	}
	if err := json.Unmarshal(b, &v); err != nil {
		return projects.AssetResult{}, err
	}
	if v.StartMS == nil || v.DurationMS == nil || v.Peaks == nil {
		return projects.AssetResult{}, errors.New("waveform response is missing required fields")
	}
	if *v.StartMS != s.StartMS || *v.DurationMS != s.DurationMS {
		return projects.AssetResult{}, errors.New("waveform response does not match requested range")
	}
	if len(v.Peaks) != s.Samples {
		return projects.AssetResult{}, errors.New("waveform response has an invalid peak count")
	}
	for _, peak := range v.Peaks {
		if math.IsNaN(peak) || math.IsInf(peak, 0) || peak < 0 || peak > 1 {
			return projects.AssetResult{}, errors.New("waveform response has an invalid peak")
		}
	}
	return projects.AssetResult{Peaks: v.Peaks, StartMS: *v.StartMS, DurationMS: *v.DurationMS, CacheStatus: status(hit), ContentType: "application/json"}, nil
}
func status(hit bool) string {
	if hit {
		return "hit"
	}
	return "miss"
}
func ms(v int64) string { return fmt.Sprintf("%d.%03d", v/1000, v%1000) }
