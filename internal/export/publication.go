package export

import (
	"errors"
	"os"
)

var errAtomicNoReplaceUnsupported = errors.New("atomic no-replace publication is unsupported on this platform")

const unsupportedPublicationMessage = "merge and separate exports are unavailable on this platform: atomic no-replace publication is supported only on Linux and macOS"

func atomicNoReplacePublicationSupported() bool {
	return platformAtomicNoReplacePublicationSupported()
}

// PublishOpenedNoReplace atomically renames a validated temporary file between
// opened directories without replacing an existing destination entry.
func PublishOpenedNoReplace(sourceDirectory, destinationDirectory *os.File, tempName, outputName string) error {
	if sourceDirectory == nil || destinationDirectory == nil {
		return errors.New("publication directories are not open")
	}
	return platformPublishOpenedNoReplace(sourceDirectory, destinationDirectory, tempName, outputName)
}
