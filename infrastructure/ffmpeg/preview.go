// Package ffmpeg runs the fixed software preview transcode safely.
package ffmpeg

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"sync"
	"syscall"
	"time"

	"editapp/application"
	"editapp/domain"
)

const (
	fdInput         = "/proc/self/fd/3"
	defaultGrace    = 2 * time.Second
	defaultStderr   = 64 << 10
	softwareProfile = "software-h264-v1"
)

// Timing records lifecycle milestones without adding fields to the frozen
// PreviewRunner contract. OnTiming receives snapshots at spawn, first byte, and completion.
type Timing struct {
	SpawnedAt        time.Time
	FirstByteAt      time.Time
	CompletedAt      time.Time
	SpawnToFirstByte time.Duration
	Total            time.Duration
}

// Runner starts one software fMP4 preview process.
type Runner struct {
	Path        string
	GracePeriod time.Duration
	StderrLimit int
	OnTiming    func(Timing)
}

// BuildPreviewArgs builds a fixed argument array. It deliberately has no
// source path argument: Start provides the validated file as inherited fd 3.
func BuildPreviewArgs(spec domain.PreviewSpec) ([]string, error) {
	if spec.StartMS < 0 || spec.DurationMS < 1 || spec.Width < 1 || spec.Height < 1 || spec.Width > 1280 || spec.Height > 720 || spec.FPS < 1 || spec.FPS > 30 {
		return nil, errors.New("invalid preview spec")
	}
	if spec.Encoder != "" && spec.Encoder != softwareProfile {
		return nil, fmt.Errorf("unsupported preview encoder %q", spec.Encoder)
	}
	if spec.EncoderImpl != "" && spec.EncoderImpl != "libx264" {
		return nil, fmt.Errorf("unsupported preview encoder implementation %q", spec.EncoderImpl)
	}
	args := []string{
		"-nostdin", "-hide_banner", "-loglevel", "error",
		"-ss", milliseconds(spec.StartMS), "-i", fdInput,
		"-t", milliseconds(spec.DurationMS), "-map", "0:v:0",
		"-vf", fmt.Sprintf("scale=%d:%d:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=%d:%d:(ow-iw)/2:(oh-ih)/2:black,fps=%d", spec.Width, spec.Height, spec.Width, spec.Height, spec.FPS),
		"-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-crf", "28", "-pix_fmt", "yuv420p",
		"-g", fmt.Sprintf("%d", spec.FPS), "-keyint_min", fmt.Sprintf("%d", spec.FPS), "-sc_threshold", "0",
	}
	if spec.Audio {
		args = append(args, "-map", "0:a:0?", "-c:a", "aac", "-b:a", "96k", "-ac", "2", "-ar", "48000")
	} else {
		args = append(args, "-an")
	}
	return append(args, "-movflags", "+frag_keyframe+empty_moov+default_base_moof", "-frag_duration", "500000", "-f", "mp4", "pipe:1"), nil
}

func milliseconds(value int64) string { return fmt.Sprintf("%d.%03d", value/1000, value%1000) }

// Start transcodes an already-open original, never a client-provided path.
func (r Runner) Start(ctx context.Context, source *os.File, spec domain.PreviewSpec) (*application.RunningPreview, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if source == nil {
		return nil, errors.New("preview source is required")
	}
	args, err := BuildPreviewArgs(spec)
	if err != nil {
		return nil, err
	}
	path := r.Path
	if path == "" {
		path = "ffmpeg"
	}
	grace := r.GracePeriod
	if grace <= 0 {
		grace = defaultGrace
	}
	limit := r.StderrLimit
	if limit <= 0 {
		limit = defaultStderr
	}
	cmd := exec.Command(path, args...)
	cmd.ExtraFiles = []*os.File{source}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("ffmpeg stdout: %w", err)
	}
	stderr := &boundedBuffer{limit: limit}
	cmd.Stderr = stderr
	spawned := time.Now()
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("ffmpeg start: %w", err)
	}
	state := &timingState{timing: Timing{SpawnedAt: spawned}, publish: r.OnTiming}
	state.emit()
	done := make(chan struct{})
	var cancelled bool
	var cancelMu sync.Mutex
	go func() {
		select {
		case <-ctx.Done():
			cancelMu.Lock()
			cancelled = true
			cancelMu.Unlock()
			_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGTERM)
			timer := time.NewTimer(grace)
			defer timer.Stop()
			select {
			case <-done:
			case <-timer.C:
				_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
			}
		case <-done:
		}
	}()
	var waitOnce sync.Once
	var waitErr error
	wait := func() error {
		waitOnce.Do(func() {
			waitErr = cmd.Wait()
			close(done)
			state.complete()
			cancelMu.Lock()
			wasCancelled := cancelled
			cancelMu.Unlock()
			if wasCancelled {
				waitErr = fmt.Errorf("ffmpeg cancelled: %w", ctx.Err())
			} else if waitErr != nil {
				waitErr = fmt.Errorf("ffmpeg: %w: %s", waitErr, stderr.String())
			}
		})
		return waitErr
	}
	return &application.RunningPreview{Stdout: &timedReadCloser{ReadCloser: stdout, state: state}, PID: cmd.Process.Pid, Wait: wait}, nil
}

type boundedBuffer struct {
	mu sync.Mutex
	bytes.Buffer
	limit int
}

func (b *boundedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if remaining := b.limit - b.Len(); remaining > 0 {
		if len(p) > remaining {
			_, _ = b.Buffer.Write(p[:remaining])
		} else {
			_, _ = b.Buffer.Write(p)
		}
	}
	return len(p), nil
}

func (b *boundedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.Buffer.String()
}

type timedReadCloser struct {
	io.ReadCloser
	state *timingState
}

func (r *timedReadCloser) Read(p []byte) (int, error) {
	n, err := r.ReadCloser.Read(p)
	if n > 0 {
		r.state.firstByte()
	}
	return n, err
}

type timingState struct {
	mu      sync.Mutex
	timing  Timing
	publish func(Timing)
}

func (s *timingState) firstByte() {
	s.mu.Lock()
	if s.timing.FirstByteAt.IsZero() {
		s.timing.FirstByteAt = time.Now()
		s.timing.SpawnToFirstByte = s.timing.FirstByteAt.Sub(s.timing.SpawnedAt)
	}
	s.mu.Unlock()
	s.emit()
}

func (s *timingState) complete() {
	s.mu.Lock()
	s.timing.CompletedAt = time.Now()
	s.timing.Total = s.timing.CompletedAt.Sub(s.timing.SpawnedAt)
	s.mu.Unlock()
	s.emit()
}

func (s *timingState) emit() {
	if s.publish == nil {
		return
	}
	s.mu.Lock()
	timing := s.timing
	s.mu.Unlock()
	s.publish(timing)
}
