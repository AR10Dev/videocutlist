//go:build !linux && !darwin

package export

import (
	"context"
	"errors"
	"os"
)

// A process-local mutex cannot protect a shared output directory. Platforms
// without the publication lock must refuse to create a batch archive.
func acquireBatchArchiveLock(context.Context, string) (func(), error) {
	return nil, errors.Join(ErrOutputUnavailable, errors.New("batch archive publication requires a process-shared filesystem lock"))
}

func batchArchiveFileIdentity(os.FileInfo) (device, inode uint64, ok bool) {
	return 0, 0, false
}
