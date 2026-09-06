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

func publishOpenedNoReplace(sourceDirectory, destinationDirectory *os.File, tempName, outputName string, destinationRoot *os.Root, sourceRootName string) error {
	return platformPublishOpenedNoReplace(sourceDirectory, destinationDirectory, tempName, outputName, destinationRoot, sourceRootName)
}
