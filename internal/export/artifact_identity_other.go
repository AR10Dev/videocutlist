//go:build !linux && !darwin

package export

import "os"

func manifestFileIdentity(os.FileInfo) (device, inode uint64, ok bool) {
	return 0, 0, false
}
