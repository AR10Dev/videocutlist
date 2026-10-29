package export

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"videocutlist/internal/exportpolicy"
)

func validateAllocatedFilename(name string) error {
	if len(name) > maxAllocatedFilenameBytes {
		return fmt.Errorf("final allocated export filename exceeds %d bytes", maxAllocatedFilenameBytes)
	}
	return nil
}

func (p preparedDestination) outputFileName(request Request, source string, segment int, at time.Time) (string, error) {
	policy, ok := exportpolicy.For(request.Container)
	if !ok {
		return "", fmt.Errorf("%w: unsupported export container", ErrInvalidRequest)
	}
	values := map[string]string{"source": strings.TrimSuffix(filepath.Base(source), filepath.Ext(source)), "date": at.Format("20060102"), "time": at.Format("150405"), "segment": strconv.Itoa(segment + 1), "mode": request.Mode, "ext": policy.Extension}
	name, err := RenderTemplate(request.FilenameTemplate, values)
	if err != nil {
		return "", fmt.Errorf("%w: %w", ErrInvalidRequest, err)
	}
	for range 100 {
		candidateName := name
		if candidateName == "" {
			candidateName = "cut-" + uniqueSuffix()
		}
		candidateName = strings.TrimSuffix(candidateName, "."+policy.Extension) + "-" + uniqueSuffix() + "." + policy.Extension
		if err := validateAllocatedFilename(candidateName); err != nil {
			return "", fmt.Errorf("%w: %w", ErrInvalidRequest, err)
		}
		_, statErr := p.root.Lstat(candidateName)
		if errors.Is(statErr, os.ErrNotExist) {
			return candidateName, nil
		}
		if statErr != nil {
			return "", statErr
		}
	}
	return "", errors.New("could not allocate collision-safe export name")
}

func safeFailureMessage(err error) string {
	if err == nil {
		return "output could not be created"
	}
	var b strings.Builder
	for _, character := range err.Error() {
		if character < 32 || character == 127 {
			b.WriteByte(' ')
		} else if character == '/' || character == '\\' {
			b.WriteByte('_')
		} else {
			b.WriteRune(character)
		}
		if b.Len() == 500 {
			break
		}
	}
	if b.Len() == 0 {
		return "output could not be created"
	}
	return b.String()
}

func copyOpenFileToOpen(source, destination *os.File) error {
	if source == nil || destination == nil {
		return errors.New("copy file descriptors are required")
	}
	if _, err := destination.Seek(0, io.SeekStart); err != nil {
		return err
	}
	if err := destination.Truncate(0); err != nil {
		return err
	}
	_, err := io.Copy(destination, source)
	return err
}
