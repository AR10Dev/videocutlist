//go:build !aix && !darwin && !dragonfly && !freebsd && !illumos && !linux && !netbsd && !openbsd && !solaris

package index

import "os"

// Platforms without the Unix nonblocking-open flag reject known special files
// before opening. The descriptor is still checked by openMedia after opening;
// these platforms need a platform-specific atomic nonblocking open to cover
// file-type swaps between the check and open.
func openRootedMedia(root *os.Root, name string) (*os.File, error) {
	info, err := root.Stat(name)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, ErrSourceChanged
	}
	return root.Open(name)
}
