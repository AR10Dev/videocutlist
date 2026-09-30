//go:build darwin

package cache

import "golang.org/x/sys/unix"

func renameCachePartial(source, destination string) error {
	return unix.RenameatxNp(unix.AT_FDCWD, source, unix.AT_FDCWD, destination, unix.RENAME_EXCL)
}
