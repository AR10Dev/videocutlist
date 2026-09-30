//go:build !linux && !darwin && !windows

package cache

import (
	"errors"
	"os"
)

// TouchFile returns ErrUnsupported when descriptor-bound timestamps are unavailable.
func TouchFile(_ *os.File) error {
	// No descriptor-only timestamp setter is available on these platforms.
	// A path-based update could follow a symlink swapped in after validation;
	// preserve safe cache hits rather than update their eviction recency.
	return errors.ErrUnsupported
}
