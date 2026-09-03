//go:build !windows

package export

import (
	"os"
	"syscall"
)

func terminate(process *os.Process) error { return process.Signal(syscall.SIGTERM) }
