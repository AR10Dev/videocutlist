//go:build !linux && !darwin && !windows

package cache

import (
	"errors"
	"os"
)

func renameCachePartial(source, destination string) error {
	// The caller holds the Store's publication locks. Without a native
	// no-replace rename, the cache root must have a single Store writer.
	if _, err := os.Lstat(destination); !errors.Is(err, os.ErrNotExist) {
		if err == nil {
			return os.ErrExist
		}
		return err
	}
	return os.Rename(source, destination)
}
