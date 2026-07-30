// Package hardware verifies encoder availability with real short transcodes.
package hardware

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"strings"
	"sync"
	"time"
)

const (
	Software = "software"
	NVENC    = "nvenc"
	VAAPI    = "vaapi"
	QSV      = "qsv"
)

// Result is cached for both successful and failed capability probes.
type Result struct {
	Profile   string
	Available bool
	Err       error
}

// Detector probes hardware encoders on demand. Software remains selectable
// even when every hardware probe fails.
type Detector struct {
	Path    string
	Timeout time.Duration

	mu      sync.Mutex
	results map[string]Result
}

// Probe runs one actual synthetic-frame transcode for a hardware profile.
func (d *Detector) Probe(ctx context.Context, profile string) Result {
	if profile == Software {
		return Result{Profile: Software, Available: true}
	}
	d.mu.Lock()
	if d.results != nil {
		if result, ok := d.results[profile]; ok {
			d.mu.Unlock()
			return result
		}
	}
	d.mu.Unlock()
	result := d.probe(ctx, profile)
	d.mu.Lock()
	if d.results == nil {
		d.results = make(map[string]Result)
	}
	if cached, ok := d.results[profile]; ok {
		d.mu.Unlock()
		return cached
	}
	d.results[profile] = result
	d.mu.Unlock()
	return result
}

func (d *Detector) probe(ctx context.Context, profile string) Result {
	args, err := args(profile)
	if err != nil {
		return Result{Profile: profile, Err: err}
	}
	path := d.Path
	if path == "" {
		path = "ffmpeg"
	}
	timeout := d.Timeout
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	probeCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(probeCtx, path, args...)
	var stderr boundedBuffer
	stderr.limit = 8 << 10
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return Result{Profile: profile, Err: fmt.Errorf("%s probe: %w: %s", profile, err, stderr.String())}
	}
	return Result{Profile: profile, Available: true}
}

// Choose returns the first verified preferred hardware profile, or software.
func (d *Detector) Choose(ctx context.Context, preference string) string {
	for _, profile := range strings.Split(preference, ",") {
		profile = strings.ToLower(strings.TrimSpace(profile))
		if profile == "" || profile == Software {
			continue
		}
		if d.Probe(ctx, profile).Available {
			return profile
		}
	}
	return Software
}

func args(profile string) ([]string, error) {
	base := []string{"-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=size=16x16:rate=1", "-frames:v", "1"}
	switch profile {
	case NVENC:
		return append(base, "-c:v", "h264_nvenc", "-f", "null", "-"), nil
	case VAAPI:
		return append(base, "-vaapi_device", "/dev/dri/renderD128", "-vf", "format=nv12,hwupload", "-c:v", "h264_vaapi", "-f", "null", "-"), nil
	case QSV:
		return append(base, "-c:v", "h264_qsv", "-f", "null", "-"), nil
	default:
		return nil, fmt.Errorf("unknown hardware profile %q", profile)
	}
}

type boundedBuffer struct {
	bytes.Buffer
	limit int
}

func (b *boundedBuffer) Write(p []byte) (int, error) {
	if remaining := b.limit - b.Len(); remaining > 0 {
		if len(p) > remaining {
			_, _ = b.Buffer.Write(p[:remaining])
		} else {
			_, _ = b.Buffer.Write(p)
		}
	}
	return len(p), nil
}
