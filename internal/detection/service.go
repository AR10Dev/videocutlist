package detection

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"math"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"sync"

	jobqueue "videocutlist/internal/jobs"
	"videocutlist/internal/library/media/index"
	"videocutlist/internal/projects"
	"videocutlist/internal/projects/model"
)

type Service struct {
	Scanner    *index.Scanner
	Catalog    index.Catalog
	FFmpegPath string
	Capacity   projects.ProcessLimiter

	slotMu sync.Mutex
	slots  chan struct{}
}

var silenceStart = regexp.MustCompile(`silence_start: ([0-9.]+)`)
var silenceEnd = regexp.MustCompile(`silence_end: ([0-9.]+)`)
var blackRange = regexp.MustCompile(`black_start: ([0-9.]+).*black_end: ([0-9.]+)`)
var scenePoint = regexp.MustCompile(`pts_time:([0-9.]+)`)

const maxDetectionCandidates = 1000
const maxDetectionInput = 1 << 20

func (s *Service) Detect(ctx context.Context, request projects.DetectionRequest) ([]model.Candidate, error) {
	if err := projects.ValidateDetectionRequest(request); err != nil {
		return nil, err
	}
	if s.Scanner == nil || s.Catalog == nil || s.FFmpegPath == "" {
		return nil, fmt.Errorf("detection service is not configured")
	}
	file, media, err := s.Scanner.Open(ctx, s.Catalog, request.MediaID)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	if request.SourceFingerprint != "" && index.SourceFingerprint(media) != request.SourceFingerprint {
		return nil, jobqueue.ErrSourceChanged
	}
	f, ok := file.(*os.File)
	if !ok {
		return nil, fmt.Errorf("media is not seekable")
	}
	noiseDB := request.NoiseDB
	if noiseDB == 0 {
		noiseDB = -30
	}
	minDuration := float64(request.MinDurationMS) / 1000
	if minDuration == 0 {
		minDuration = 0.5
	}
	sceneThreshold := request.SceneThreshold
	if sceneThreshold == 0 {
		sceneThreshold = 0.4
	}
	filter := map[model.DetectionKind]string{model.DetectBlack: fmt.Sprintf("blackdetect=d=%g:pix_th=0.10", minDuration), model.DetectScene: fmt.Sprintf("select='gt(scene,%g)',showinfo", sceneThreshold)}[request.Kind]
	args := []string{"-hide_banner", "-nostats", "-i", "/proc/self/fd/3"}
	if request.Kind == model.DetectSilence {
		args = append(args, "-vn", "-af", fmt.Sprintf("silencedetect=noise=%gdB:d=%g", noiseDB, minDuration))
	} else {
		args = append(args, "-vf", filter, "-an")
	}
	args = append(args, "-f", "null", "-")
	releaseDetection, err := s.acquireSlot(ctx)
	if err != nil {
		return nil, err
	}
	defer releaseDetection()
	if s.Capacity != nil {
		release, err := projects.AcquireProcess(ctx, s.Capacity)
		if err != nil {
			return nil, err
		}
		defer release()
	}
	cmd := exec.CommandContext(ctx, s.FFmpegPath, args...)
	cmd.ExtraFiles = []*os.File{f}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	data, readErr := io.ReadAll(io.LimitReader(stderr, maxDetectionInput+1))
	if readErr != nil || len(data) > maxDetectionInput {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, fmt.Errorf("ffmpeg detection failed")
	}
	waitErr := cmd.Wait()
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	if waitErr != nil {
		return nil, fmt.Errorf("ffmpeg detection failed")
	}
	return parse(request, media.Metadata.DurationMS, string(data)), nil
}

func (s *Service) acquireSlot(ctx context.Context) (func(), error) {
	s.slotMu.Lock()
	if s.slots == nil {
		s.slots = make(chan struct{}, 1)
	}
	slots := s.slots
	s.slotMu.Unlock()
	select {
	case slots <- struct{}{}:
		return func() { <-slots }, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}
func parse(request projects.DetectionRequest, duration int64, text string) []model.Candidate {
	var out []model.Candidate
	scanner := bufio.NewScanner(strings.NewReader(text))
	var start float64
	var haveStart bool
	for scanner.Scan() {
		line := scanner.Text()
		switch request.Kind {
		case model.DetectSilence:
			if m := silenceStart.FindStringSubmatch(line); len(m) == 2 {
				if value, ok := finiteFloat(m[1]); ok {
					start, haveStart = value, true
				}
			}
			if m := silenceEnd.FindStringSubmatch(line); len(m) == 2 && haveStart {
				if end, ok := finiteFloat(m[1]); ok {
					appendRangeCandidate(&out, request, float64(duration), start, end)
				}
				haveStart = false
			}
		case model.DetectBlack:
			if m := blackRange.FindStringSubmatch(line); len(m) == 3 {
				if a, ok := finiteFloat(m[1]); ok {
					if b, ok := finiteFloat(m[2]); ok {
						appendRangeCandidate(&out, request, float64(duration), a, b)
					}
				}
			}
		case model.DetectScene:
			if m := scenePoint.FindStringSubmatch(line); len(m) == 2 {
				if a, ok := finiteFloat(m[1]); ok {
					appendPointCandidate(&out, request, float64(duration), a)
				}
			}
		}
	}
	return out
}

func finiteFloat(value string) (float64, bool) {
	parsed, err := strconv.ParseFloat(value, 64)
	return parsed, err == nil && !math.IsNaN(parsed) && !math.IsInf(parsed, 0)
}

func appendRangeCandidate(out *[]model.Candidate, request projects.DetectionRequest, duration, start, end float64) {
	if len(*out) >= maxDetectionCandidates || !validDetectionTime(duration, start) || !validDetectionTime(duration, end) {
		return
	}
	start = math.Max(0, math.Min(start, duration/1000))
	end = math.Max(0, math.Min(end, duration/1000))
	if end <= start {
		return
	}
	*out = append(*out, rangeCandidate(request, start, end))
}

func appendPointCandidate(out *[]model.Candidate, request projects.DetectionRequest, duration, point float64) {
	if len(*out) >= maxDetectionCandidates || !validDetectionTime(duration, point) || duration <= 0 {
		return
	}
	point = math.Max(0, math.Min(point, duration/1000))
	pointMS := int64(math.Round(point * 1000))
	*out = append(*out, pointCandidate(request, pointMS))
}

func validDetectionTime(duration, value float64) bool {
	return duration > 0 && !math.IsNaN(value) && !math.IsInf(value, 0) && value >= 0
}

func rangeCandidate(r projects.DetectionRequest, start, end float64) model.Candidate {
	return model.Candidate{ID: fmt.Sprintf("c_%s_%x", r.Kind, uint64(start*1000)), MediaID: r.MediaID, ProjectID: r.ProjectID, ProjectRevision: r.ProjectRevision, StartMS: int64(start * 1000), EndMS: int64(end * 1000), Source: r.Kind}
}

func pointCandidate(r projects.DetectionRequest, pointMS int64) model.Candidate {
	return model.Candidate{ID: fmt.Sprintf("c_%s_%d", r.Kind, pointMS), MediaID: r.MediaID, ProjectID: r.ProjectID, ProjectRevision: r.ProjectRevision, PointMS: &pointMS, Source: r.Kind}
}
