//go:build windows

package cache

import (
	"os"
	"time"

	"golang.org/x/sys/windows"
)

var reopenCacheFile = windows.NewLazySystemDLL("kernel32.dll").NewProc("ReOpenFile")

// TouchFile updates cache recency through the opened descriptor, never its path.
func TouchFile(f *os.File) error {
	// The read-only handle from OpenInRoot lacks FILE_WRITE_ATTRIBUTES.
	// ReOpenFile grants that right on the same file, without resolving its path.
	h, _, err := reopenCacheFile.Call(
		f.Fd(),
		uintptr(windows.FILE_WRITE_ATTRIBUTES),
		uintptr(windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE),
		0,
	)
	if windows.Handle(h) == windows.InvalidHandle {
		return err
	}
	defer windows.CloseHandle(windows.Handle(h))
	now := windows.NsecToFiletime(time.Now().UnixNano())
	return windows.SetFileTime(windows.Handle(h), nil, &now, &now)
}
