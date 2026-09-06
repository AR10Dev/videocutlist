//go:build !linux && !darwin

package export

import "os"

func platformAtomicNoReplacePublicationSupported() bool { return false }

func platformPublishOpenedNoReplace(_ *os.File, _ *os.File, _, _ string, _ *os.Root, _ string) error {
	return errAtomicNoReplaceUnsupported
}
