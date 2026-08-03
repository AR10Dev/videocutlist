// Package export creates stream-copy MKV exports from already-open originals.
package export

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"time"

	"videocutlist/domain"
	"videocutlist/infrastructure/media/probe"
)

const maxStderrBytes = 64 << 10

var (
	ErrCancelled      = errors.New("export cancelled")
	ErrInvalidRequest = errors.New("invalid export request")
)

type Request struct {
	Mode        string `json:"mode"`
	CutStrategy string `json:"cutStrategy"`
	Container   string `json:"container"`
}

type Warning struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// Result deliberately contains only an output name, never a filesystem path.
type Result struct {
	OutputName  string    `json:"outputName"`
	SizeBytes   int64     `json:"sizeBytes"`
	RetainUntil time.Time `json:"retainUntil"`
	Warnings    []Warning `json:"warnings,omitempty"`
}

type Service struct {
	FFmpegPath  string
	FFprobePath string
	OutputDir   string
	Retention   time.Duration
	Now         func() time.Time
}

func (s Service) Run(ctx context.Context, source *os.File, document domain.Document, request Request) (Result, error) {
	if source == nil {
		return Result{}, errors.New("export source is required")
	}
	if request.Mode != "merge" || request.CutStrategy != "stream_copy_preferred" || request.Container != "mkv" {
		return Result{}, fmt.Errorf("%w: only merge, stream_copy_preferred, and mkv are supported", ErrInvalidRequest)
	}
	if len(document.Segments) == 0 {
		return Result{}, fmt.Errorf("%w: at least one segment is required", ErrInvalidRequest)
	}
	for _, segment := range document.Segments {
		if segment.StartMS < 0 || segment.EndMS <= segment.StartMS {
			return Result{}, fmt.Errorf("%w: invalid segment bounds", ErrInvalidRequest)
		}
	}
	if s.OutputDir == "" {
		return Result{}, errors.New("export output directory is required")
	}
	if err := os.MkdirAll(s.OutputDir, 0o750); err != nil {
		return Result{}, fmt.Errorf("create export directory: %w", err)
	}
	outputName, err := uniqueName(s.OutputDir, now(s))
	if err != nil {
		return Result{}, err
	}
	temporaryOutput, err := os.CreateTemp(s.OutputDir, ".export-*.mkv")
	if err != nil {
		return Result{}, fmt.Errorf("create export temporary file: %w", err)
	}
	temporaryPath := temporaryOutput.Name()
	if err := temporaryOutput.Close(); err != nil {
		os.Remove(temporaryPath)
		return Result{}, err
	}
	defer os.Remove(temporaryPath)

	workDir, err := os.MkdirTemp(s.OutputDir, ".export-segments-")
	if err != nil {
		return Result{}, err
	}
	defer os.RemoveAll(workDir)

	segments := make([]string, len(document.Segments))
	for i, segment := range document.Segments {
		segments[i] = filepath.Join(workDir, fmt.Sprintf("segment-%03d.mkv", i))
		if err := s.copySegment(ctx, source, segment, segments[i]); err != nil {
			return Result{}, err
		}
	}
	if len(segments) == 1 {
		if err := copyFile(segments[0], temporaryPath); err != nil {
			return Result{}, err
		}
	} else if err := s.concat(ctx, workDir, segments, temporaryPath); err != nil {
		return Result{}, err
	}

	if _, err := (probe.Client{Path: s.FFprobePath}).Probe(ctx, temporaryPath); err != nil {
		return Result{}, fmt.Errorf("validate export: %w", err)
	}
	finalPath := filepath.Join(s.OutputDir, outputName)
	if err := os.Rename(temporaryPath, finalPath); err != nil {
		return Result{}, fmt.Errorf("publish export: %w", err)
	}
	info, err := os.Stat(finalPath)
	if err != nil {
		return Result{}, err
	}
	result := Result{OutputName: outputName, SizeBytes: info.Size(), RetainUntil: now(s).Add(retention(s))}
	if hasPotentiallyInexactCut(document.Segments) {
		result.Warnings = []Warning{{
			Code:    "stream_copy_cut_may_not_be_frame_exact",
			Message: "Stream-copy cuts can start on an earlier keyframe; requested non-keyframe boundaries are not frame-exact.",
		}}
	}
	return result, nil
}

func (s Service) copySegment(ctx context.Context, source *os.File, segment domain.Segment, output string) error {
	if _, err := source.Seek(0, io.SeekStart); err != nil {
		return fmt.Errorf("rewind export source: %w", err)
	}
	args := []string{"-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-ss", seconds(segment.StartMS), "-i", sourceArgument(), "-t", seconds(segment.EndMS - segment.StartMS), "-map", "0", "-c", "copy", "-avoid_negative_ts", "make_zero", output}
	return s.run(ctx, source, args)
}

func (s Service) concat(ctx context.Context, workDir string, segments []string, output string) error {
	manifest := "ffconcat version 1.0\n"
	for _, segment := range segments {
		manifest += "file '" + filepath.Base(segment) + "'\n"
	}
	manifestPath := filepath.Join(workDir, "segments.ffconcat")
	if err := os.WriteFile(manifestPath, []byte(manifest), 0o600); err != nil {
		return err
	}
	args := []string{"-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "1", "-i", filepath.Base(manifestPath), "-c", "copy", output}
	return s.runInDir(ctx, nil, workDir, args)
}

func (s Service) run(ctx context.Context, source *os.File, args []string) error {
	return s.runInDir(ctx, source, "", args)
}

func (s Service) runInDir(ctx context.Context, source *os.File, dir string, args []string) error {
	path := s.FFmpegPath
	if path == "" {
		path = "ffmpeg"
	}
	cmd := exec.Command(path, args...)
	cmd.Dir = dir
	if source != nil {
		cmd.ExtraFiles = []*os.File{source} // Child descriptor 3; no original pathname is passed.
	}
	var stderr limitedBuffer
	stderr.limit = maxStderrBytes
	cmd.Stderr = &stderr
	if err := runCommand(ctx, cmd); err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return fmt.Errorf("%w: %v", ErrCancelled, err)
		}
		if stderr.err != nil {
			return fmt.Errorf("ffmpeg output exceeded limit: %w", stderr.err)
		}
		return fmt.Errorf("ffmpeg export failed: %w", err)
	}
	if stderr.err != nil {
		return fmt.Errorf("ffmpeg output exceeded limit: %w", stderr.err)
	}
	return nil
}

func runCommand(ctx context.Context, cmd *exec.Cmd) error {
	if err := cmd.Start(); err != nil {
		return err
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		return err
	case <-ctx.Done():
		_ = terminate(cmd.Process)
		timer := time.NewTimer(2 * time.Second)
		defer timer.Stop()
		select {
		case <-done:
		case <-timer.C:
			_ = cmd.Process.Kill()
			<-done
		}
		return ctx.Err()
	}
}

func sourceArgument() string {
	if runtime.GOOS == "linux" {
		return "/proc/self/fd/3" // A fixed inherited descriptor remains seekable for input-side -ss.
	}
	return "pipe:3"
}

func hasPotentiallyInexactCut(segments []domain.Segment) bool {
	for _, segment := range segments {
		if segment.StartMS > 0 {
			return true
		}
	}
	return false
}

func seconds(milliseconds int64) string {
	return strconv.FormatFloat(float64(milliseconds)/1000, 'f', 3, 64)
}

func now(s Service) time.Time {
	if s.Now != nil {
		return s.Now().UTC()
	}
	return time.Now().UTC()
}

func retention(s Service) time.Duration {
	if s.Retention > 0 {
		return s.Retention
	}
	return 30 * 24 * time.Hour
}

func uniqueName(directory string, at time.Time) (string, error) {
	for range 10 {
		var random [16]byte
		if _, err := rand.Read(random[:]); err != nil {
			return "", err
		}
		name := "videocutlist-" + at.Format("20060102T150405.000000000Z") + "-" + hex.EncodeToString(random[:]) + ".mkv"
		if _, err := os.Stat(filepath.Join(directory, name)); errors.Is(err, os.ErrNotExist) {
			return name, nil
		} else if err != nil {
			return "", err
		}
	}
	return "", errors.New("could not allocate collision-safe export name")
}

func copyFile(source, destination string) error {
	in, err := os.Open(source)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(destination, os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(out, in)
	closeErr := out.Close()
	if copyErr != nil {
		return copyErr
	}
	return closeErr
}

type limitedBuffer struct {
	bytes.Buffer
	limit int
	err   error
}

func (b *limitedBuffer) Write(data []byte) (int, error) {
	if b.err != nil {
		return 0, b.err
	}
	if b.Len()+len(data) > b.limit {
		b.err = errors.New("stderr exceeds limit")
		return 0, b.err
	}
	return b.Buffer.Write(data)
}

var _ io.Writer = (*limitedBuffer)(nil)
