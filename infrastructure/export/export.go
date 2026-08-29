// Package export creates stream-copy MKV exports from already-open originals.
package export

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"

	"videocutlist/domain"
	"videocutlist/infrastructure/media/probe"
)

const maxStderrBytes = 64 << 10

var (
	ErrCancelled                      = errors.New("export cancelled")
	ErrInvalidRequest                 = errors.New("invalid export request")
	ErrHybridSmartCutUnsupportedMedia = errors.New("hybrid smart cut unsupported media")
)

type Request struct {
	Mode             string `json:"mode"`
	Selection        string `json:"selection"`
	StreamIndexes    []int  `json:"streamIndexes,omitempty"`
	CutStrategy      string `json:"cutStrategy"`
	Container        string `json:"container"`
	DestinationID    string `json:"destinationId,omitempty"`
	FilenameTemplate string `json:"filenameTemplate,omitempty"`
	JobID            string `json:"-"`
}

type Warning struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type AppliedStrategy struct {
	Segment    int    `json:"segment"`
	OutputName string `json:"outputName,omitempty"`
	Strategy   string `json:"strategy"`
}

// Result deliberately contains only an output name, never a filesystem path.
type Result struct {
	OutputName        string            `json:"outputName,omitempty"`
	OutputNames       []string          `json:"outputNames,omitempty"`
	SizeBytes         int64             `json:"sizeBytes"`
	RetainUntil       time.Time         `json:"retainUntil"`
	DestinationID     string            `json:"destinationId,omitempty"`
	DestinationKind   string            `json:"destinationKind,omitempty"`
	Warnings          []Warning         `json:"warnings,omitempty"`
	AppliedStrategy   string            `json:"appliedStrategy,omitempty"`
	AppliedStrategies []AppliedStrategy `json:"appliedStrategies,omitempty"`
	Verified          bool              `json:"verified"`
}

type ProcessLimiter interface {
	AcquireProcess() (func(), error)
}

type Service struct {
	FFmpegPath   string
	FFprobePath  string
	OutputDir    string // backwards-compatible default download destination
	Destinations []Destination
	Artifacts    *ArtifactStore
	Retention    time.Duration
	Now          func() time.Time
	Capacity     ProcessLimiter
}

func (s Service) Run(ctx context.Context, source *os.File, document domain.Document, request Request) (Result, error) {
	if source == nil {
		return Result{}, errors.New("export source is required")
	}
	if s.Capacity != nil {
		release, err := s.Capacity.AcquireProcess()
		if err != nil {
			return Result{}, err
		}
		defer release()
	}
	if (request.Mode != "merge" && request.Mode != "separate") || (request.CutStrategy != "stream_copy_preferred" && request.CutStrategy != "precise_reencode" && request.CutStrategy != "hybrid_smart_cut") || request.Container != "mkv" || (request.Selection != "" && request.Selection != "segments" && request.Selection != "gaps") {
		return Result{}, fmt.Errorf("%w: unsupported export options", ErrInvalidRequest)
	}
	if request.Selection == "" {
		request.Selection = "segments"
	}
	var metadata probe.Metadata
	var probeErr error
	if err := ctx.Err(); err != nil {
		return Result{}, fmt.Errorf("%w: %v", ErrCancelled, err)
	}
	metadata, probeErr = (probe.Client{Path: s.FFprobePath}).ProbeFile(ctx, source)
	if probeErr != nil {
		if err := ctx.Err(); err != nil {
			return Result{}, fmt.Errorf("%w: %v", ErrCancelled, err)
		}
		return Result{}, fmt.Errorf("probe export source: %w", probeErr)
	}
	preflight := Preflight(request, metadata)
	if !preflight.Allowed {
		return Result{}, fmt.Errorf("%w: export preflight blocked", ErrInvalidRequest)
	}
	request.StreamIndexes = preflight.Selection
	if request.Selection == "gaps" { /* metadata is also needed for duration below */
	}
	segments := append([]domain.Segment(nil), document.Segments...)
	if request.Selection == "gaps" {
		segments = selectedSegments(document.Segments, request.Selection, metadata.DurationMS)
	}
	if len(segments) == 0 {
		return Result{}, fmt.Errorf("%w: at least one segment is required", ErrInvalidRequest)
	}
	for _, segment := range segments {
		if segment.StartMS < 0 || segment.EndMS <= segment.StartMS {
			return Result{}, fmt.Errorf("%w: invalid segment bounds", ErrInvalidRequest)
		}
	}
	var keyframes []int64
	hybridInterior := false
	if request.CutStrategy != "precise_reencode" {
		var err error
		keyframes, err = (probe.Client{Path: s.FFprobePath}).Keyframes(ctx, source)
		if err != nil {
			return Result{}, fmt.Errorf("probe export keyframes: %w", err)
		}
		if request.CutStrategy == "hybrid_smart_cut" {
			if !hybridSupported(metadata) || strings.ToLower(filepath.Ext(source.Name())) != ".mkv" {
				return Result{}, fmt.Errorf("%w: %w: hybrid smart cut requires H.264 CFR MKV", ErrInvalidRequest, ErrHybridSmartCutUnsupportedMedia)
			}
			frameTimes, err := (probe.Client{Path: s.FFprobePath}).FrameTimes(ctx, source)
			if err != nil || !constantFrameTimes(frameTimes) {
				return Result{}, fmt.Errorf("%w: %w: hybrid smart cut requires finite CFR timestamps", ErrInvalidRequest, ErrHybridSmartCutUnsupportedMedia)
			}
			for _, segment := range segments {
				if hasInteriorKeyframe(segment, keyframes) {
					hybridInterior = true
					break
				}
			}
		}
	}
	destination := Destination{ID: "download", Kind: KindDownload, Root: s.OutputDir, Retention: s.Retention}
	for _, candidate := range s.Destinations {
		if candidate.ID == request.DestinationID || request.DestinationID == "" && candidate.ID == "download" {
			destination = candidate
			break
		}
	}
	if request.DestinationID != "" && destination.ID != request.DestinationID {
		return Result{}, fmt.Errorf("%w: unknown destination", ErrInvalidRequest)
	}
	outputDir, err := destinationRoot(destination, source.Name())
	if err != nil {
		return Result{}, fmt.Errorf("%w: %v", ErrInvalidRequest, err)
	}
	outputDir, err = prepareDestinationRoot(outputDir)
	if err != nil {
		return Result{}, fmt.Errorf("create export directory: %w", err)
	}
	outputName, err := outputFileName(outputDir, request, source.Name(), 0, now(s))
	if err != nil {
		return Result{}, err
	}
	var manifestPath string
	manifestPublished := false
	if s.Artifacts != nil && request.JobID != "" && request.Mode != "separate" {
		manifestPath, err = WriteManifest(outputDir, request.JobID, destination.Kind, []string{outputName}, now(s).Add(destinationRetention(destination, s)))
		if err != nil {
			return Result{}, err
		}
		s.Artifacts.RegisterManifest(request.JobID, manifestPath)
		defer func() {
			if manifestPath != "" && !manifestPublished {
				s.Artifacts.ClearManifest(request.JobID)
			}
		}()
	}
	temporaryOutput, err := os.CreateTemp(outputDir, ".videocutlist-export-*.mkv")
	if err != nil {
		return Result{}, fmt.Errorf("create export temporary file: %w", err)
	}
	temporaryPath := temporaryOutput.Name()
	if err := temporaryOutput.Close(); err != nil {
		os.Remove(temporaryPath)
		return Result{}, err
	}
	defer os.Remove(temporaryPath)

	workDir, err := os.MkdirTemp(outputDir, ".videocutlist-segments-")
	if err != nil {
		return Result{}, err
	}
	defer os.RemoveAll(workDir)

	segmentFiles := make([]string, len(segments))
	for i, segment := range segments {
		segmentFiles[i] = filepath.Join(workDir, fmt.Sprintf("segment-%03d.mkv", i))
		if err := s.copySegment(ctx, source, segment, segmentFiles[i], request, keyframes); err != nil {
			return Result{}, err
		}
	}
	appliedStrategies := segmentStrategies(request.CutStrategy, segments, keyframes)
	if request.Mode == "separate" {
		result := Result{OutputNames: make([]string, 0, len(segmentFiles)), RetainUntil: now(s).Add(destinationRetention(destination, s)), DestinationID: destination.ID, DestinationKind: destination.Kind, AppliedStrategy: uniformStrategy(appliedStrategies), AppliedStrategies: appliedStrategies}
		published := make([]string, 0, len(segmentFiles))
		committed := false
		separateNames := make([]string, len(segmentFiles))
		for i := range separateNames {
			separateNames[i], err = outputFileName(outputDir, request, source.Name(), i, now(s))
			if err != nil {
				return Result{}, err
			}
		}
		if s.Artifacts != nil && request.JobID != "" {
			manifestPath, err = WriteManifest(outputDir, request.JobID, destination.Kind, separateNames, result.RetainUntil)
			if err != nil {
				return Result{}, err
			}
			s.Artifacts.RegisterManifest(request.JobID, manifestPath)
		}
		defer func() {
			if !committed {
				for _, path := range published {
					_ = os.Remove(path)
				}
			}
		}()
		for i, segmentFile := range segmentFiles {
			if err := verifyOutput(ctx, s.FFprobePath, segmentFile, metadata, request.StreamIndexes, segments[i].EndMS-segments[i].StartMS); err != nil {
				return Result{}, fmt.Errorf("validate export: %w", err)
			}
			name := separateNames[i]
			publishedPath := filepath.Join(outputDir, name)
			if err := os.Rename(segmentFile, publishedPath); err != nil {
				return Result{}, err
			}
			published = append(published, publishedPath)
			info, err := os.Stat(publishedPath)
			if err != nil {
				return Result{}, err
			}
			result.OutputNames = append(result.OutputNames, name)
			result.AppliedStrategies[i].OutputName = name
			result.SizeBytes += info.Size()
		}
		if request.CutStrategy == "precise_reencode" {
			result.Warnings = []Warning{{Code: "experimental_precise_reencode", Message: "Experimental full re-encode mode; output boundaries and codec behavior require inspection."}}
		} else if request.CutStrategy == "hybrid_smart_cut" {
			result.Warnings = hybridWarnings(segments, keyframes, hybridInterior)
		} else if hasPotentiallyInexactCut(segments, keyframes) {
			result.Warnings = []Warning{{Code: "stream_copy_cut_may_not_be_frame_exact", Message: "Stream-copy cuts can start on an earlier keyframe; requested non-keyframe boundaries are not frame-exact."}}
		}
		result.Verified = request.CutStrategy != "precise_reencode"
		committed = true
		if s.Artifacts != nil {
			values := make([]Artifact, len(result.OutputNames))
			for i, name := range result.OutputNames {
				values[i] = Artifact{Path: filepath.Join(outputDir, name), Name: name, Kind: destination.Kind, Expires: result.RetainUntil}
			}
			s.Artifacts.Put(request.JobID, values)
		}
		return result, nil
	}
	if len(segmentFiles) == 1 {
		if err := copyFile(segmentFiles[0], temporaryPath); err != nil {
			return Result{}, err
		}
	} else if err := s.concat(ctx, workDir, segmentFiles, temporaryPath); err != nil {
		return Result{}, err
	}

	expectedDuration := int64(0)
	for _, segment := range segments {
		expectedDuration += segment.EndMS - segment.StartMS
	}
	if err := verifyOutput(ctx, s.FFprobePath, temporaryPath, metadata, request.StreamIndexes, expectedDuration); err != nil {
		return Result{}, fmt.Errorf("validate export: %w", err)
	}
	finalPath := filepath.Join(outputDir, outputName)
	if err := os.Rename(temporaryPath, finalPath); err != nil {
		return Result{}, fmt.Errorf("publish export: %w", err)
	}
	manifestPublished = true
	info, err := os.Stat(finalPath)
	if err != nil {
		return Result{}, err
	}
	result := Result{OutputName: outputName, SizeBytes: info.Size(), RetainUntil: now(s).Add(destinationRetention(destination, s)), DestinationID: destination.ID, DestinationKind: destination.Kind, AppliedStrategy: uniformStrategy(appliedStrategies), AppliedStrategies: appliedStrategies, Verified: request.CutStrategy != "precise_reencode"}
	if s.Artifacts != nil {
		s.Artifacts.Put(request.JobID, []Artifact{{Path: finalPath, Name: outputName, Kind: destination.Kind, Expires: result.RetainUntil}})
	}
	if request.CutStrategy == "precise_reencode" {
		result.Warnings = []Warning{{Code: "experimental_precise_reencode", Message: "Experimental full re-encode mode; output boundaries and codec behavior require inspection."}}
	} else if request.CutStrategy == "hybrid_smart_cut" {
		result.Warnings = hybridWarnings(segments, keyframes, hybridInterior)
	} else if hasPotentiallyInexactCut(segments, keyframes) {
		result.Warnings = []Warning{{
			Code:    "stream_copy_cut_may_not_be_frame_exact",
			Message: "Stream-copy cuts can start on an earlier keyframe; requested non-keyframe boundaries are not frame-exact.",
		}}
	}
	return result, nil
}

func (s Service) copySegment(ctx context.Context, source *os.File, segment domain.Segment, output string, request Request, keyframes []int64) error {
	if request.CutStrategy == "hybrid_smart_cut" {
		return s.hybridSegment(ctx, source, segment, output, keyframes, request.StreamIndexes)
	}
	if _, err := source.Seek(0, io.SeekStart); err != nil {
		return fmt.Errorf("rewind export source: %w", err)
	}
	args := []string{"-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-ss", seconds(segment.StartMS), "-i", sourceArgument(), "-t", seconds(segment.EndMS - segment.StartMS)}
	if len(request.StreamIndexes) == 0 {
		args = append(args, "-map", "0")
	} else {
		for _, index := range request.StreamIndexes {
			args = append(args, "-map", fmt.Sprintf("0:%d", index))
		}
	}
	args = append(args, "-avoid_negative_ts", "make_zero")
	if request.CutStrategy == "precise_reencode" {
		args = append(args, "-c:v", "libx264", "-c:a", "aac")
	} else {
		args = append(args, "-c", "copy")
	}
	args = append(args, output)
	return s.run(ctx, source, args)
}

func hybridSupported(metadata probe.Metadata) bool {
	return metadata.Container == "matroska,webm" && metadata.Video != nil && metadata.Video.Codec == "h264" && validCFR(metadata.Video.AvgFrameRate, metadata.Video.FrameRate)
}

func validCFR(avg, rate string) bool {
	parse := func(value string) (int64, int64, bool) {
		parts := strings.Split(value, "/")
		if len(parts) != 2 {
			return 0, 0, false
		}
		n, e1 := strconv.ParseInt(parts[0], 10, 64)
		d, e2 := strconv.ParseInt(parts[1], 10, 64)
		return n, d, e1 == nil && e2 == nil && n > 0 && d > 0
	}
	an, ad, ok := parse(avg)
	rn, rd, rok := parse(rate)
	return ok && rok && an*rd == rn*ad
}

func constantFrameTimes(times []int64) bool {
	if len(times) < 2 {
		return false
	}
	delta := times[1] - times[0]
	if delta <= 0 {
		return false
	}
	for i := 2; i < len(times); i++ {
		step := times[i] - times[i-1]
		if step <= 0 || abs64(step-delta) > 1 {
			return false
		}
	}
	return true
}

func abs64(value int64) int64 {
	if value < 0 {
		return -value
	}
	return value
}

func hasInteriorKeyframe(segment domain.Segment, keyframes []int64) bool {
	for _, keyframe := range keyframes {
		if keyframe > segment.StartMS && keyframe < segment.EndMS {
			return true
		}
	}
	return false
}

func hybridWarnings(segments []domain.Segment, keyframes []int64, interior bool) []Warning {
	warnings := make([]Warning, 0, 1+len(segments))
	if interior {
		warnings = append(warnings, Warning{Code: "experimental_hybrid_smart_cut", Message: hybridWarning(true)})
	}
	for index, segment := range segments {
		if !hasInteriorKeyframe(segment, keyframes) {
			warnings = append(warnings, Warning{Code: "hybrid_smart_cut_stream_copy_fallback", Message: fmt.Sprintf("Segment %d had no compatible interior keyframe; the requested span was stream-copied and may not be frame-exact.", index+1)})
		}
	}
	if len(warnings) == 0 {
		warnings = append(warnings, Warning{Code: hybridWarningCode(false), Message: hybridWarning(false)})
	}
	return warnings
}

func hybridWarningCode(interior bool) string {
	if interior {
		return "experimental_hybrid_smart_cut"
	}
	return "hybrid_smart_cut_stream_copy_fallback"
}

func hybridWarning(interior bool) string {
	if interior {
		return "Experimental H.264 CFR MKV hybrid cut; the leading video boundary is re-encoded, the remaining video span is stream-copied, and audio is consistently AAC-encoded. Output is not frame-exact without probe confirmation."
	}
	return "Hybrid Smart Cut found no compatible interior keyframe; the requested span was stream-copied and may not be frame-exact."
}

func hybridArgs(input string, startMS, durationMS int64, streamIndexes []int, videoCodec, audioCodec, output string) []string {
	args := []string{"-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", input, "-ss", seconds(startMS), "-t", seconds(durationMS)}
	if len(streamIndexes) == 0 {
		args = append(args, "-map", "0")
	} else {
		for _, index := range streamIndexes {
			args = append(args, "-map", fmt.Sprintf("0:%d", index))
		}
	}
	return append(args, "-avoid_negative_ts", "make_zero", "-c:v", videoCodec, "-c:a", audioCodec, output)
}

func (s Service) hybridSegment(ctx context.Context, source *os.File, segment domain.Segment, output string, keyframes []int64, streamIndexes []int) error {
	boundary := int64(-1)
	for _, keyframe := range keyframes {
		if keyframe >= segment.StartMS {
			boundary = keyframe
			break
		}
	}
	if boundary <= segment.StartMS || boundary >= segment.EndMS {
		return s.copySegment(ctx, source, segment, output, Request{CutStrategy: "stream_copy_preferred", StreamIndexes: streamIndexes}, nil)
	}
	workDir, err := os.MkdirTemp(filepath.Dir(output), ".smart-cut-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(workDir)
	prefix, suffix := filepath.Join(workDir, "prefix.mkv"), filepath.Join(workDir, "suffix.mkv")
	if _, err := source.Seek(0, io.SeekStart); err != nil {
		return err
	}
	prefixArgs := hybridArgs(sourceArgument(), segment.StartMS, boundary-segment.StartMS, streamIndexes, "libx264", "aac", prefix)
	if err := s.run(ctx, source, prefixArgs); err != nil {
		return err
	}
	if _, err := source.Seek(0, io.SeekStart); err != nil {
		return err
	}
	suffixArgs := hybridArgs(sourceArgument(), boundary, segment.EndMS-boundary, streamIndexes, "copy", "aac", suffix)
	if err := s.run(ctx, source, suffixArgs); err != nil {
		return err
	}
	return s.concat(ctx, workDir, []string{prefix, suffix}, output)
}

func (s Service) concat(ctx context.Context, workDir string, segments []string, output string) error {
	manifest := "ffconcat version 1.0\n"
	for _, segment := range segments {
		manifest += "file '" + filepath.Base(segment) + "'\n"
	}
	manifestPath := filepath.Join(workDir, "segments.ffconcat")
	if err := os.WriteFile(manifestPath, []byte(manifest), 0o600); err != nil {
		return err
	}
	args := []string{"-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "1", "-i", filepath.Base(manifestPath), "-c", "copy", output}
	return s.runInDir(ctx, nil, workDir, args)
}

func (s Service) run(ctx context.Context, source *os.File, args []string) error {
	return s.runInDir(ctx, source, "", args)
}

func (s Service) runInDir(ctx context.Context, source *os.File, dir string, args []string) error {
	path := s.FFmpegPath
	if path == "" {
		path = "ffmpeg"
	}
	cmd := exec.Command(path, args...)
	cmd.Dir = dir
	if source != nil {
		cmd.ExtraFiles = []*os.File{source} // Child descriptor 3; no original pathname is passed.
	}
	var stderr limitedBuffer
	stderr.limit = maxStderrBytes
	cmd.Stderr = &stderr
	if err := runCommand(ctx, cmd); err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return fmt.Errorf("%w: %v", ErrCancelled, err)
		}
		if stderr.err != nil {
			return fmt.Errorf("ffmpeg output exceeded limit: %w", stderr.err)
		}
		return fmt.Errorf("ffmpeg export failed: %w", err)
	}
	if stderr.err != nil {
		return fmt.Errorf("ffmpeg output exceeded limit: %w", stderr.err)
	}
	return nil
}

func runCommand(ctx context.Context, cmd *exec.Cmd) error {
	if err := cmd.Start(); err != nil {
		return err
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		return err
	case <-ctx.Done():
		_ = terminate(cmd.Process)
		timer := time.NewTimer(2 * time.Second)
		defer timer.Stop()
		select {
		case <-done:
		case <-timer.C:
			_ = cmd.Process.Kill()
			<-done
		}
		return ctx.Err()
	}
}

func sourceArgument() string {
	if runtime.GOOS == "linux" {
		return "/proc/self/fd/3" // A fixed inherited descriptor remains seekable for input-side -ss.
	}
	return "pipe:3"
}

func validateStreamIndexes(indexes []int, streams []probe.Stream) error {
	if len(indexes) == 0 {
		return nil
	}
	known := map[int]bool{}
	for _, stream := range streams {
		known[stream.Index] = true
	}
	seen := map[int]bool{}
	for _, index := range indexes {
		if index < 0 || !known[index] {
			return fmt.Errorf("unknown stream index %d", index)
		}
		if seen[index] {
			return fmt.Errorf("duplicate stream index %d", index)
		}
		seen[index] = true
	}
	return nil
}

func selectedSegments(segments []domain.Segment, selection string, duration int64) []domain.Segment {
	if selection == "segments" {
		return append([]domain.Segment(nil), segments...)
	}
	ordered := append([]domain.Segment(nil), segments...)
	sort.Slice(ordered, func(i, j int) bool { return ordered[i].StartMS < ordered[j].StartMS })
	var gaps []domain.Segment
	cursor := int64(0)
	for _, segment := range ordered {
		if cursor < segment.StartMS {
			gaps = append(gaps, domain.Segment{StartMS: cursor, EndMS: segment.StartMS})
		}
		if segment.EndMS > cursor {
			cursor = segment.EndMS
		}
	}
	if cursor < duration {
		gaps = append(gaps, domain.Segment{StartMS: cursor, EndMS: duration})
	}
	return gaps
}

func segmentStrategies(requested string, segments []domain.Segment, keyframes []int64) []AppliedStrategy {
	strategies := make([]AppliedStrategy, len(segments))
	for i, segment := range segments {
		strategy := requested
		if requested == "hybrid_smart_cut" && !hasInteriorKeyframe(segment, keyframes) {
			strategy = "stream_copy"
		}
		strategies[i] = AppliedStrategy{Segment: i + 1, Strategy: strategy}
	}
	return strategies
}

func uniformStrategy(strategies []AppliedStrategy) string {
	if len(strategies) == 0 {
		return ""
	}
	strategy := strategies[0].Strategy
	for _, value := range strategies[1:] {
		if value.Strategy != strategy {
			return ""
		}
	}
	return strategy
}

func hasPotentiallyInexactCut(segments []domain.Segment, keyframes []int64) bool {
	for _, segment := range segments {
		if !slices.Contains(keyframes, segment.StartMS) {
			return true
		}
	}
	return false
}

func seconds(milliseconds int64) string {
	return strconv.FormatFloat(float64(milliseconds)/1000, 'f', 3, 64)
}

func now(s Service) time.Time {
	if s.Now != nil {
		return s.Now().UTC()
	}
	return time.Now().UTC()
}

func retention(s Service) time.Duration {
	if s.Retention > 0 {
		return s.Retention
	}
	return 24 * time.Hour
}
func destinationRetention(d Destination, s Service) time.Duration {
	if d.Kind == KindArchive {
		return 100 * 365 * 24 * time.Hour
	}
	if d.Retention > 0 {
		return d.Retention
	}
	return retention(s)
}

func outputFileName(directory string, request Request, source string, segment int, at time.Time) (string, error) {
	values := map[string]string{"source": strings.TrimSuffix(filepath.Base(source), filepath.Ext(source)), "date": at.Format("20060102"), "time": at.Format("150405"), "segment": strconv.Itoa(segment + 1), "mode": request.Mode, "ext": "mkv"}
	name, err := RenderTemplate(request.FilenameTemplate, values)
	if err != nil {
		return "", fmt.Errorf("%w: %v", ErrInvalidRequest, err)
	}
	if name == "" {
		name = "cut-" + uniqueSuffix()
	}
	name = strings.TrimSuffix(name, ".mkv") + "-" + uniqueSuffix() + ".mkv"
	candidate := filepath.Join(directory, name)
	if _, err := os.Stat(candidate); err == nil {
		return outputFileName(directory, request, source, segment, at)
	}
	return name, nil
}

func uniqueName(directory string, at time.Time) (string, error) {
	for range 10 {
		var random [16]byte
		if _, err := rand.Read(random[:]); err != nil {
			return "", err
		}
		name := "videocutlist-" + at.Format("20060102T150405.000000000Z") + "-" + hex.EncodeToString(random[:]) + ".mkv"
		if _, err := os.Stat(filepath.Join(directory, name)); errors.Is(err, os.ErrNotExist) {
			return name, nil
		} else if err != nil {
			return "", err
		}
	}
	return "", errors.New("could not allocate collision-safe export name")
}

func copyFile(source, destination string) error {
	in, err := os.Open(source)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(destination, os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(out, in)
	closeErr := out.Close()
	if copyErr != nil {
		return copyErr
	}
	return closeErr
}

type limitedBuffer struct {
	bytes.Buffer
	limit int
	err   error
}

func (b *limitedBuffer) Write(data []byte) (int, error) {
	if b.err != nil {
		return 0, b.err
	}
	if b.Len()+len(data) > b.limit {
		b.err = errors.New("stderr exceeds limit")
		return 0, b.err
	}
	return b.Buffer.Write(data)
}

var _ io.Writer = (*limitedBuffer)(nil)
