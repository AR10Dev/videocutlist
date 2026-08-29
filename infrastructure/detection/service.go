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

	"videocutlist/application"
	"videocutlist/domain"
	"videocutlist/infrastructure/media/index"
	"videocutlist/infrastructure/store"
)

type Service struct {
	Scanner    *index.Scanner
	Catalog    index.Catalog
	FFmpegPath string
}

var silenceStart = regexp.MustCompile(`silence_start: ([0-9.]+)`)
var silenceEnd = regexp.MustCompile(`silence_end: ([0-9.]+)`)
var blackRange = regexp.MustCompile(`black_start: ([0-9.]+).*black_end: ([0-9.]+)`)
var scenePoint = regexp.MustCompile(`pts_time:([0-9.]+)`)

const maxDetectionCandidates = 1000
const maxDetectionInput = 1 << 20

func (s Service) Detect(ctx context.Context, request application.DetectionRequest) ([]domain.Candidate, error) {
	if err := application.ValidateDetectionRequest(request); err != nil {
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
		return nil, store.ErrSourceChanged
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
	filter := map[domain.DetectionKind]string{domain.DetectBlack: fmt.Sprintf("blackdetect=d=%g:pix_th=0.10", minDuration), domain.DetectScene: fmt.Sprintf("select='gt(scene,%g)',showinfo", sceneThreshold)}[request.Kind]
	args := []string{"-hide_banner", "-nostats", "-i", fmt.Sprintf("/proc/self/fd/%d", f.Fd())}
	if request.Kind == domain.DetectSilence {
		args = append(args, "-af", fmt.Sprintf("silencedetect=noise=%gdB:d=%g", noiseDB, minDuration))
	} else {
		args = append(args, "-vf", filter, "-an")
	}
	args = append(args, "-f", "null", "-")
	cmd := exec.CommandContext(ctx, s.FFmpegPath, args...)
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	data, readErr := io.ReadAll(io.LimitReader(stderr, maxDetectionInput+1))
	waitErr := cmd.Wait()
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	if readErr != nil || waitErr != nil || len(data) > maxDetectionInput {
		return nil, fmt.Errorf("ffmpeg detection failed")
	}
	return parse(request, media.Metadata.DurationMS, string(data)), nil
}
func parse(request application.DetectionRequest, duration int64, text string) []domain.Candidate {
	var out []domain.Candidate
	scanner := bufio.NewScanner(strings.NewReader(text))
	var start float64
	var haveStart bool
	for scanner.Scan() {
		line := scanner.Text()
		switch request.Kind {
		case domain.DetectSilence:
			if m := silenceStart.FindStringSubmatch(line); len(m) == 2 {
				if value, ok := finiteFloat(m[1]); ok {
					start, haveStart = value, true
				}
			}
			if m := silenceEnd.FindStringSubmatch(line); len(m) == 2 && haveStart {
				if end, ok := finiteFloat(m[1]); ok {
					appendCandidate(&out, request, float64(duration), start, end, .9)
				}
				haveStart = false
			}
		case domain.DetectBlack:
			if m := blackRange.FindStringSubmatch(line); len(m) == 3 {
				if a, ok := finiteFloat(m[1]); ok {
					if b, ok := finiteFloat(m[2]); ok {
						appendCandidate(&out, request, float64(duration), a, b, .8)
					}
				}
			}
		case domain.DetectScene:
			if m := scenePoint.FindStringSubmatch(line); len(m) == 2 {
				if a, ok := finiteFloat(m[1]); ok {
					appendCandidate(&out, request, float64(duration), a, a+.001, .7)
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

func appendCandidate(out *[]domain.Candidate, request application.DetectionRequest, duration, start, end, confidence float64) {
	if len(*out) >= maxDetectionCandidates || math.IsNaN(start) || math.IsInf(start, 0) || math.IsNaN(end) || math.IsInf(end, 0) || math.IsNaN(confidence) || math.IsInf(confidence, 0) || duration <= 0 || confidence < 0 || confidence > 1 {
		return
	}
	start = math.Max(0, math.Min(start, float64(duration)/1000))
	end = math.Max(0, math.Min(end, float64(duration)/1000))
	if end <= start {
		return
	}
	*out = append(*out, candidate(request, start, end, confidence))
}
func candidate(r application.DetectionRequest, start, end, confidence float64) domain.Candidate {
	return domain.Candidate{ID: fmt.Sprintf("c_%x", uint64(start*1000)), MediaID: r.MediaID, ProjectID: r.ProjectID, ProjectRevision: r.ProjectRevision, StartMS: int64(start * 1000), EndMS: int64(end * 1000), Source: r.Kind, Confidence: confidence}
}
