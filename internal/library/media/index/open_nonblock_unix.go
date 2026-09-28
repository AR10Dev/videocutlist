//go:build aix || darwin || dragonfly || freebsd || illumos || linux || netbsd || openbsd || solaris

package index

import (
	"os"

	"golang.org/x/sys/unix"
)

// O_NONBLOCK prevents a media path replaced by a FIFO from hanging inside open.
// Root.OpenFile still enforces rooted resolution, and openMedia stats the exact
// descriptor after opening to reject non-regular files.
func openRootedMedia(root *os.Root, name string) (*os.File, error) {
	return root.OpenFile(name, os.O_RDONLY|unix.O_NONBLOCK, 0)
}
