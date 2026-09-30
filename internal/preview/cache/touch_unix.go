//go:build linux || darwin

package cache

import (
	"os"

	"golang.org/x/sys/unix"
)

// TouchFile updates cache recency through the opened descriptor, never its path.
func TouchFile(f *os.File) error {
	return unix.Futimes(int(f.Fd()), nil)
}
