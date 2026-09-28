// Package fdinput names inherited child-process descriptors for FFmpeg and
// FFprobe argument vectors. Linux exposes dup'ed descriptors under
// /proc/self/fd; Darwin provides the same seekable view under /dev/fd. Other
// platforms fall back to FFmpeg's pipe syntax, which is not seekable, so
// input-side seeking strategies are unsupported there.
package fdinput

import (
	"fmt"
	"os"
	"runtime"
)

// Path returns the command-line input name for inherited descriptor fd.
func Path(fd uintptr) string {
	switch runtime.GOOS {
	case "linux":
		return fmt.Sprintf("/proc/self/fd/%d", fd)
	case "darwin":
		return fmt.Sprintf("/dev/fd/%d", fd)
	default:
		return fmt.Sprintf("pipe:%d", fd)
	}
}

// Directory returns a working-directory reference that stays valid after extra
// descriptors are inherited, for platforms with /proc-style descriptor paths.
// It returns "" elsewhere, in which case callers must pass a real directory
// path via Cmd.Dir.
func Directory(file *os.File) string {
	if file == nil {
		return ""
	}
	switch runtime.GOOS {
	case "linux":
		return fmt.Sprintf("/proc/self/fd/%d", file.Fd())
	case "darwin":
		return fmt.Sprintf("/dev/fd/%d", file.Fd())
	default:
		return ""
	}
}
