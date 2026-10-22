package export

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"time"
	"videocutlist/internal/exportpolicy"
	"videocutlist/internal/fdinput"
	"videocutlist/internal/processio"
)

func (s Service) concatToFile(ctx context.Context, workRoot *os.Root, workDirectory *os.File, segments []string, output *os.File, policy exportpolicy.Policy) error {
	manifest := "ffconcat version 1.0\n"
	for _, segment := range segments {
		manifest += "file '" + filepath.Base(segment) + "'\n"
	}
	if err := workRoot.WriteFile("segments.ffconcat", []byte(manifest), 0o600); err != nil {
		return err
	}
	args := []string{"-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "1", "-i", "segments.ffconcat", "-c", "copy", "output." + policy.Extension}
	return s.runWithOutput(ctx, nil, output, workDirectory, args, policy)
}

func (s Service) runWithOutput(ctx context.Context, source, output, directory *os.File, args []string, policy exportpolicy.Policy) error {
	path := s.FFmpegPath
	if path == "" {
		path = "ffmpeg"
	}
	args = slices.Clone(args)
	extraFiles := make([]*os.File, 0, 3)
	if source != nil {
		extraFiles = append(extraFiles, source) // Child descriptor 3; no original pathname is passed.
	}
	if output != nil {
		extraFiles = append(extraFiles, output)
		if len(args) == 0 {
			return errors.New("ffmpeg output arguments are required")
		}
		outputArgs := slices.Clone(args[:len(args)-1])
		outputLabel := filepath.Base(args[len(args)-1])
		if outputLabel != "" && outputLabel != "." {
			outputArgs = append(outputArgs, "-metadata", "videocutlist-output="+outputLabel)
		}
		if policy.FastStart {
			outputArgs = append(outputArgs, "-movflags", "+faststart")
		}
		outputArgs = append(outputArgs, "-f", policy.Muxer)
		outputDescriptor := 3 + len(extraFiles) - 1
		args = append(outputArgs, fdinput.Path(uintptr(outputDescriptor)))
	}
	if directory != nil {
		extraFiles = append(extraFiles, directory)
	}
	cmd := exec.Command(path, args...)
	if directory != nil {
		// Cmd.Dir is resolved before ExtraFiles are installed in the child;
		// use the already-open parent descriptor, not its child slot.
		cmd.Dir = fdinput.Directory(directory)
	}
	cmd.ExtraFiles = extraFiles
	stderr := processio.NewLimitedBuffer(maxStderrBytes, errors.New("stderr exceeds limit"))
	cmd.Stderr = stderr
	if err := runCommand(ctx, cmd); err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return fmt.Errorf("%w: %w", ErrCancelled, err)
		}
		if stderr.Err() != nil {
			return fmt.Errorf("ffmpeg output exceeded limit: %w", stderr.Err())
		}
		return fmt.Errorf("ffmpeg export failed: %w", err)
	}
	if stderr.Err() != nil {
		return fmt.Errorf("ffmpeg output exceeded limit: %w", stderr.Err())
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

// sourceArgument names the inherited source descriptor for FFmpeg input. The
// Linux and Darwin paths are seekable so input-side -ss works; other platforms
// fall back to FFmpeg pipe syntax, where only output-side seeks work.
func sourceArgument() string {
	return fdinput.Path(3)
}
