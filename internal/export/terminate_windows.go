//go:build windows

package export

import "os"

func terminate(process *os.Process) error { return process.Kill() }
