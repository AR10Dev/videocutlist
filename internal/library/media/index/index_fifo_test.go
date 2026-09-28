//go:build linux || darwin

package index

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

// A blocked FIFO open cannot be cancelled through os.Root.Open, so run the
// regression in a child process that the parent can terminate on timeout.
func fifoTestProcess(t *testing.T, testName string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^"+testName+"$")
	cmd.Env = append(os.Environ(), "VIDEOCUTLIST_TEST_FIFO_CHILD="+testName)
	output, err := cmd.CombinedOutput()
	if ctx.Err() != nil {
		t.Fatalf("media operation blocked on FIFO: %v; child: %s", ctx.Err(), output)
	}
	if err != nil {
		t.Fatalf("FIFO child failed: %v; output: %s", err, output)
	}
}

func TestScanSkipsMediaNamedFIFO(t *testing.T) {
	if os.Getenv("VIDEOCUTLIST_TEST_FIFO_CHILD") == "TestScanSkipsMediaNamedFIFO" {
		root := t.TempDir()
		if err := unix.Mkfifo(filepath.Join(root, "clip.mp4"), 0o600); err != nil {
			t.Fatal(err)
		}
		scanner, err := NewScanner([]Root{{Alias: "camera", Path: root}}, fakeProbe{})
		if err != nil {
			t.Fatal(err)
		}
		records, err := scanner.Scan(t.Context(), "camera")
		if err != nil || len(records) != 0 {
			t.Fatalf("FIFO scan: records=%v err=%v", records, err)
		}
		return
	}
	fifoTestProcess(t, "TestScanSkipsMediaNamedFIFO")
}

func TestOpenRejectsSourceReplacedByFIFO(t *testing.T) {
	if os.Getenv("VIDEOCUTLIST_TEST_FIFO_CHILD") == "TestOpenRejectsSourceReplacedByFIFO" {
		root := t.TempDir()
		path := filepath.Join(root, "clip.mp4")
		if err := os.WriteFile(path, []byte("clip"), 0o600); err != nil {
			t.Fatal(err)
		}
		scanner, err := NewScanner([]Root{{Alias: "camera", Path: root}}, fakeProbe{})
		if err != nil {
			t.Fatal(err)
		}
		catalog := &memoryCatalog{}
		if err := scanner.Refresh(t.Context(), catalog); err != nil {
			t.Fatal(err)
		}
		if err := os.Remove(path); err != nil {
			t.Fatal(err)
		}
		if err := unix.Mkfifo(path, 0o600); err != nil {
			t.Fatal(err)
		}
		file, _, err := scanner.Open(t.Context(), catalog, MediaID("camera", "clip.mp4"))
		if file != nil {
			_ = file.Close()
		}
		if !errors.Is(err, ErrSourceChanged) {
			t.Fatalf("replaced source error = %v, want ErrSourceChanged", err)
		}
		return
	}
	fifoTestProcess(t, "TestOpenRejectsSourceReplacedByFIFO")
}

func TestOpenRejectsSourceReplacedBySymlinkToFIFO(t *testing.T) {
	if os.Getenv("VIDEOCUTLIST_TEST_FIFO_CHILD") == "TestOpenRejectsSourceReplacedBySymlinkToFIFO" {
		root := t.TempDir()
		path := filepath.Join(root, "clip.mp4")
		if err := os.WriteFile(path, []byte("clip"), 0o600); err != nil {
			t.Fatal(err)
		}
		scanner, err := NewScanner([]Root{{Alias: "camera", Path: root}}, fakeProbe{})
		if err != nil {
			t.Fatal(err)
		}
		catalog := &memoryCatalog{}
		if err := scanner.Refresh(t.Context(), catalog); err != nil {
			t.Fatal(err)
		}
		if err := unix.Mkfifo(filepath.Join(root, "blocked.mp4"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Remove(path); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink("blocked.mp4", path); err != nil {
			t.Fatal(err)
		}
		file, _, err := scanner.Open(t.Context(), catalog, MediaID("camera", "clip.mp4"))
		if file != nil {
			_ = file.Close()
		}
		if !errors.Is(err, ErrSourceChanged) {
			t.Fatalf("symlink-to-FIFO source error = %v, want ErrSourceChanged", err)
		}
		return
	}
	fifoTestProcess(t, "TestOpenRejectsSourceReplacedBySymlinkToFIFO")
}
