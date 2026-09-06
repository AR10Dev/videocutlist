//go:build darwin

package export

import (
	"os"

	"golang.org/x/sys/unix"
)

func platformAtomicNoReplacePublicationSupported() bool { return true }

func platformPublishOpenedNoReplace(sourceDirectory, destinationDirectory *os.File, tempName, outputName string, _ *os.Root, _ string) error {
	return unix.RenameatxNp(
		int(sourceDirectory.Fd()),
		tempName,
		int(destinationDirectory.Fd()),
		outputName,
		unix.RENAME_EXCL,
	)
}
