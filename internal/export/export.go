// Package export creates stream-copy MKV exports from already-open originals.
package export

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"videocutlist/internal/exportpolicy"
	"videocutlist/internal/library/media/probe"
	"videocutlist/internal/preview"
	"videocutlist/internal/projects/model"
)

const (
	maxStderrBytes            = 64 << 10
	maxAllocatedFilenameBytes = 255
)

// MaxExportOutputs is the shared separate-export artifact bound.
const MaxExportOutputs = exportpolicy.MaxOutputs

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

	// These fields are populated only by the server-side media resolver. They
	// keep original paths out of durable/API request documents.
	SourceRoot      string `json:"-"` // Canonical configured media root.
	SourceRelative  string `json:"-"` // Slash-normalized path below SourceRoot.
	SourceName      string `json:"-"`
	SourceSizeBytes int64  `json:"-"`
	SourceMtimeNS   int64  `json:"-"`
}

func (request Request) withDefaults() Request {
	options := (model.ExportOptions{
		Mode: request.Mode, Selection: request.Selection,
		CutStrategy: request.CutStrategy, Container: request.Container,
	}).WithExportDefaults()
	request.Mode, request.Selection = options.Mode, options.Selection
	request.CutStrategy, request.Container = options.CutStrategy, options.Container
	return request
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

type OutputFailure struct {
	Segment int    `json:"segment"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

type StrategyCapability struct {
	Strategy  string   `json:"strategy"`
	Supported bool     `json:"supported"`
	Reasons   []string `json:"reasons"`
}

type Capabilities struct {
	Strategies []StrategyCapability `json:"strategies"`
}

// Result deliberately contains only an output name, never a filesystem path.
type Result struct {
	Container         string            `json:"container"`
	OutputName        string            `json:"outputName,omitempty"`
	OutputNames       []string          `json:"outputNames,omitempty"`
	SizeBytes         int64             `json:"sizeBytes"`
	RetainUntil       time.Time         `json:"retainUntil"`
	DestinationID     string            `json:"destinationId,omitempty"`
	DestinationKind   string            `json:"destinationKind,omitempty"`
	Warnings          []Warning         `json:"warnings,omitempty"`
	OutputFailures    []OutputFailure   `json:"outputFailures,omitempty"`
	AppliedStrategy   string            `json:"appliedStrategy,omitempty"`
	AppliedStrategies []AppliedStrategy `json:"appliedStrategies,omitempty"`
	Verified          bool              `json:"verified"`
}

type Service struct {
	FFmpegPath   string
	FFprobePath  string
	OutputDir    string // backwards-compatible default download destination
	Destinations []Destination
	Artifacts    *ArtifactStore
	Retention    time.Duration
	Now          func() time.Time
	Capacity     preview.ProcessLimiter
}

func (s Service) Run(ctx context.Context, source *os.File, document model.Document, request Request) (Result, error) {
	if source == nil {
		return Result{}, errors.New("export source is required")
	}
	request = request.withDefaults()
	policy, policyOK := exportpolicy.For(request.Container)
	if !policyOK {
		return Result{}, fmt.Errorf("%w: unsupported export container", ErrInvalidRequest)
	}
	request.Container = policy.Name
	if !atomicNoReplacePublicationSupported() {
		return Result{}, fmt.Errorf("%w: %s", ErrInvalidRequest, unsupportedPublicationMessage)
	}
	sourceName := request.SourceName
	if sourceName == "" {
		sourceName = source.Name()
	}
	if s.Capacity != nil {
		release, err := preview.AcquireProcess(ctx, s.Capacity)
		if err != nil {
			return Result{}, err
		}
		defer release()
	}
	if (request.Mode != "merge" && request.Mode != "separate") || (request.CutStrategy != "stream_copy_preferred" && request.CutStrategy != "precise_reencode" && request.CutStrategy != "hybrid_smart_cut") || (request.Selection != "" && request.Selection != "segments" && request.Selection != "gaps") {
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
	if err := s.checkCapabilities(ctx, policy, request.CutStrategy); err != nil {
		if ctx.Err() != nil {
			return Result{}, fmt.Errorf("%w: %v", ErrCancelled, err)
		}
		return Result{}, fmt.Errorf("%w: %v", ErrInvalidRequest, err)
	}
	request.StreamIndexes = preflight.Selection
	if len(document.Items) != 1 {
		return Result{}, fmt.Errorf("%w: export requires one project item", ErrInvalidRequest)
	}
	segments := ResolveRanges(document.Items[0].Segments, request.Selection, metadata.DurationMS)
	if len(segments) == 0 {
		return Result{}, fmt.Errorf("%w: at least one segment is required", ErrInvalidRequest)
	}
	if request.Mode == "separate" && len(segments) > MaxExportOutputs {
		return Result{}, fmt.Errorf("%w: separate export exceeds %d outputs", ErrInvalidRequest, MaxExportOutputs)
	}
	for _, segment := range segments {
		if segment.StartMS < 0 || segment.EndMS <= segment.StartMS {
			return Result{}, fmt.Errorf("%w: invalid segment bounds", ErrInvalidRequest)
		}
	}
	if request.CutStrategy == "hybrid_smart_cut" {
		if reasons := hybridMetadataCapabilityReasons(metadata, sourceName); len(reasons) > 0 {
			return Result{}, fmt.Errorf("%w: %w: hybrid smart cut unsupported: %s", ErrInvalidRequest, ErrHybridSmartCutUnsupportedMedia, strings.Join(reasons, ","))
		}
	}
	var keyframes []int64
	hybridInterior := false
	if request.CutStrategy != "precise_reencode" {
		var err error
		keyframes, err = (probe.Client{Path: s.FFprobePath}).Keyframes(ctx, source)
		if err != nil {
			if ctx.Err() != nil {
				return Result{}, fmt.Errorf("%w: %v", ErrCancelled, ctx.Err())
			}
			return Result{}, fmt.Errorf("probe export keyframes: %w", err)
		}
		if request.CutStrategy == "hybrid_smart_cut" {
			frameTimes, err := (probe.Client{Path: s.FFprobePath}).FrameTimes(ctx, source)
			if err != nil {
				if ctx.Err() != nil {
					return Result{}, fmt.Errorf("%w: %v", ErrCancelled, ctx.Err())
				}
				return Result{}, fmt.Errorf("%w: %w: hybrid smart cut requires finite CFR timestamps: %w", ErrInvalidRequest, ErrHybridSmartCutUnsupportedMedia, err)
			}
			if reasons := hybridCapabilityReasons(metadata, sourceName, frameTimes); len(reasons) > 0 {
				return Result{}, fmt.Errorf("%w: %w: hybrid smart cut unsupported: %s", ErrInvalidRequest, ErrHybridSmartCutUnsupportedMedia, strings.Join(reasons, ","))
			}
			for _, segment := range segments {
				if hasInteriorKeyframe(segment, keyframes) {
					hybridInterior = true
					break
				}
			}
		}
	}
	if request.SourceSizeBytes > 0 || request.SourceMtimeNS > 0 {
		info, err := source.Stat()
		if err != nil || request.SourceSizeBytes > 0 && info.Size() != request.SourceSizeBytes || request.SourceMtimeNS > 0 && info.ModTime().UnixNano() != request.SourceMtimeNS {
			return Result{}, fmt.Errorf("%w: source changed", ErrInvalidRequest)
		}
	}
	destination, err := s.destinationForRequest(request)
	if err != nil {
		return Result{}, fmt.Errorf("%w: %v", ErrInvalidRequest, err)
	}
	prepared, err := prepareDestination(destination, source, sourceName, SourceLocation{RootPath: request.SourceRoot, RelativePath: request.SourceRelative})
	if err != nil {
		return Result{}, fmt.Errorf("%w: %v", ErrInvalidRequest, err)
	}
	defer prepared.close()
	outputDir := prepared.path
	outputName, err := prepared.outputFileName(request, sourceName, 0, now(s))
	if err != nil {
		return Result{}, err
	}
	var manifestPath string
	manifestPublished := false
	mergeCommitted := false
	mergePublished := false
	var mergeOwner manifestOutput
	defer func() {
		if !mergeCommitted && mergePublished {
			prepared.removeOwned(mergeOwner)
		}
	}()
	if s.Artifacts != nil && request.JobID != "" {
		defer func() {
			if !manifestPublished {
				s.Artifacts.ClearManifest(request.JobID)
			}
		}()
	}
	temporaryOutput, temporaryName, err := prepared.createTemp(".videocutlist-export-", "."+policy.Extension)
	if err != nil {
		return Result{}, fmt.Errorf("create export temporary file: %w", err)
	}
	temporaryOutputClosed := false
	defer prepared.remove(temporaryName)
	defer func() {
		if !temporaryOutputClosed {
			// Best effort: when this cleanup runs, the temporary file is not
			// published, and a cleanup failure must not replace the primary error.
			_ = temporaryOutput.Close()
		}
	}()

	workRoot, workDirectory, workDirName, err := prepared.createTempDir(".videocutlist-segments-")
	if err != nil {
		return Result{}, err
	}
	defer prepared.removeAll(workDirName)
	defer func() {
		// Best effort: these descriptors only guard temporary work data, so
		// cleanup cannot safely change a result after output publication.
		_ = workRoot.Close()
	}()
	defer func() {
		// Best effort: preserve the primary export error if this cleanup fails.
		_ = workDirectory.Close()
	}()

	segmentFiles := make([]string, len(segments))
	var segmentFailures []OutputFailure
	for i, segment := range segments {
		segmentFiles[i] = fmt.Sprintf("segment-%03d.%s", i, policy.Extension)
		segmentOutput, openErr := workRoot.OpenFile(segmentFiles[i], os.O_RDWR|os.O_CREATE|os.O_EXCL, 0o600)
		if openErr == nil {
			openErr = s.copySegment(ctx, source, segment, segmentOutput, workRoot, workDirectory, request, keyframes, policy)
			closeErr := segmentOutput.Close()
			if openErr == nil {
				openErr = closeErr
			}
		}
		if openErr != nil {
			if request.Mode != "separate" || ctx.Err() != nil {
				return Result{}, openErr
			}
			segmentFailures = append(segmentFailures, OutputFailure{Segment: i + 1, Code: "output_generation_failed", Message: safeFailureMessage(openErr)})
			_ = workRoot.Remove(segmentFiles[i])
			segmentFiles[i] = ""
		}
	}
	appliedStrategies := segmentStrategies(request.CutStrategy, segments, keyframes)
	if request.Mode == "separate" {
		result := newResult(request.Container, destination, s, appliedStrategies)
		result.OutputNames = make([]string, 0, len(segmentFiles))
		result.OutputFailures = segmentFailures
		publishedOwners := make([]manifestOutput, 0, len(segmentFiles))
		committed := false
		separateNames := make([]string, len(segmentFiles))
		separateOwners := make([]manifestOutput, len(segmentFiles))
		reservedNames := make(map[string]bool, len(segmentFiles))
		for i := range separateNames {
			if segmentFiles[i] == "" {
				continue
			}
			separateNames[i], err = prepared.outputFileName(request, sourceName, i, now(s))
			if err != nil {
				result.OutputFailures = append(result.OutputFailures, OutputFailure{Segment: i + 1, Code: "output_name_failed", Message: safeFailureMessage(err)})
				continue
			}
			base := separateNames[i]
			for suffix := 1; reservedNames[separateNames[i]]; suffix++ {
				extension := filepath.Ext(base)
				separateNames[i] = fmt.Sprintf("%s-%d%s", strings.TrimSuffix(base, extension), suffix, extension)
			}
			if err := validateAllocatedFilename(separateNames[i]); err != nil {
				result.OutputFailures = append(result.OutputFailures, OutputFailure{Segment: i + 1, Code: "output_name_failed", Message: safeFailureMessage(err)})
				separateNames[i] = ""
				continue
			}
			reservedNames[separateNames[i]] = true
			info, statErr := workRoot.Stat(segmentFiles[i])
			if statErr != nil {
				return Result{}, statErr
			}
			device, inode, ok := manifestFileIdentity(info)
			if !ok {
				return Result{}, errors.New("cannot establish temporary output ownership")
			}
			separateOwners[i] = manifestOutput{Name: separateNames[i], Device: device, Inode: inode}
		}
		defer func() {
			if !committed {
				for _, owner := range publishedOwners {
					prepared.removeOwned(owner)
				}
			}
		}()
		for i, segmentFile := range segmentFiles {
			if segmentFile == "" || separateNames[i] == "" {
				continue
			}
			tempFile, openErr := workRoot.Open(segmentFile)
			if openErr != nil {
				result.OutputFailures = append(result.OutputFailures, OutputFailure{Segment: i + 1, Code: "output_validation_failed", Message: "temporary output is unavailable"})
				continue
			}
			tempInfo, statErr := tempFile.Stat()
			if statErr != nil || !tempInfo.Mode().IsRegular() {
				_ = tempFile.Close()
				result.OutputFailures = append(result.OutputFailures, OutputFailure{Segment: i + 1, Code: "output_validation_failed", Message: "temporary output is unavailable"})
				continue
			}
			verifyErr := verifyOutputFile(ctx, s.FFprobePath, tempFile, metadata, request.StreamIndexes, segments[i].EndMS-segments[i].StartMS, request.Container)
			if verifyErr != nil {
				_ = tempFile.Close()
				if ctx.Err() != nil {
					return Result{}, fmt.Errorf("validate export: %w", verifyErr)
				}
				result.OutputFailures = append(result.OutputFailures, OutputFailure{Segment: i + 1, Code: "output_validation_failed", Message: safeFailureMessage(verifyErr)})
				continue
			}
			currentInfo, statErr := tempFile.Stat()
			closeErr := tempFile.Close()
			if statErr != nil || closeErr != nil || !currentInfo.Mode().IsRegular() || !os.SameFile(tempInfo, currentInfo) {
				result.OutputFailures = append(result.OutputFailures, OutputFailure{Segment: i + 1, Code: "output_validation_failed", Message: "temporary output changed during validation"})
				continue
			}
			device, inode, identityOK := manifestFileIdentity(currentInfo)
			if !identityOK {
				return Result{}, errors.New("cannot establish temporary output ownership")
			}
			name := separateNames[i]
			for attempt := 0; ; attempt++ {
				if s.Artifacts != nil && request.JobID != "" {
					separateNames[i] = name
					separateOwners[i] = manifestOutput{Name: name, Device: device, Inode: inode}
					pendingNames := make([]string, 0, len(separateNames))
					pendingOwners := make([]manifestOutput, 0, len(separateOwners))
					for position, plannedName := range separateNames {
						if plannedName != "" {
							pendingNames = append(pendingNames, plannedName)
							pendingOwners = append(pendingOwners, separateOwners[position])
						}
					}
					manifestPath, err = writeManifestAtWithOwners(prepared.root, outputDir, request.JobID, destination.Kind, destination.ID, pendingNames, pendingOwners, result.RetainUntil, request.Container)
					if err != nil {
						return Result{}, err
					}
					s.Artifacts.RegisterManifest(request.JobID, manifestPath)
				}
				err = prepared.publishFrom(workDirectory, segmentFile, name)
				if err == nil {
					break
				}
				if !errors.Is(err, fs.ErrExist) || attempt == 99 {
					if ctx.Err() != nil {
						return Result{}, fmt.Errorf("publish export: %w", err)
					}
					result.OutputFailures = append(result.OutputFailures, OutputFailure{Segment: i + 1, Code: "output_publish_failed", Message: safeFailureMessage(err)})
					name = ""
					break
				}
				name, err = prepared.outputFileName(request, sourceName, i, now(s))
				if err != nil {
					result.OutputFailures = append(result.OutputFailures, OutputFailure{Segment: i + 1, Code: "output_name_failed", Message: safeFailureMessage(err)})
					name = ""
					break
				}
			}
			if name == "" {
				continue
			}
			publishedOwners = append(publishedOwners, manifestOutput{Name: name, Device: device, Inode: inode})
			info, err := prepared.root.Lstat(name)
			if err != nil {
				return Result{}, err
			}
			if !info.Mode().IsRegular() || !os.SameFile(currentInfo, info) {
				return Result{}, errors.New("published output changed")
			}
			result.OutputNames = append(result.OutputNames, name)
			result.AppliedStrategies[i].OutputName = name
			result.SizeBytes += info.Size()
		}
		applyResultMetadata(&result, request.CutStrategy, segments, keyframes, hybridInterior)
		if len(result.OutputNames) == 0 {
			return Result{}, errors.New("all separate outputs failed")
		}
		if s.Artifacts != nil && request.JobID != "" {
			manifestNames := result.OutputNames
			manifestPath, err = writeManifestAtWithOwners(prepared.root, outputDir, request.JobID, destination.Kind, destination.ID, manifestNames, publishedOwners, result.RetainUntil, request.Container)
			if err != nil {
				return Result{}, err
			}
			s.Artifacts.RegisterManifest(request.JobID, manifestPath)
			values := make([]Artifact, len(result.OutputNames))
			for i, name := range result.OutputNames {
				values[i] = Artifact{Path: filepath.Join(outputDir, name), Name: name, Kind: destination.Kind, Expires: result.RetainUntil}
			}
			s.Artifacts.Put(request.JobID, values)
		}
		manifestPublished = true
		committed = true
		return result, nil
	}
	if len(segmentFiles) == 1 {
		segmentInput, openErr := workRoot.Open(segmentFiles[0])
		if openErr != nil {
			return Result{}, openErr
		}
		copyErr := copyOpenFileToOpen(segmentInput, temporaryOutput)
		closeErr := segmentInput.Close()
		if copyErr == nil {
			copyErr = closeErr
		}
		if copyErr != nil {
			return Result{}, copyErr
		}
	} else if err := s.concatToFile(ctx, workRoot, workDirectory, segmentFiles, temporaryOutput, policy); err != nil {
		return Result{}, err
	}
	if err := temporaryOutput.Sync(); err != nil {
		return Result{}, err
	}
	expectedDuration := int64(0)
	for _, segment := range segments {
		expectedDuration += segment.EndMS - segment.StartMS
	}
	if err := verifyOutputFile(ctx, s.FFprobePath, temporaryOutput, metadata, request.StreamIndexes, expectedDuration, request.Container); err != nil {
		return Result{}, fmt.Errorf("validate export: %w", err)
	}
	temporaryInfo, err := temporaryOutput.Stat()
	if err != nil {
		return Result{}, err
	}
	device, inode, identityOK := manifestFileIdentity(temporaryInfo)
	if !identityOK {
		return Result{}, errors.New("cannot establish temporary output ownership")
	}
	if err := temporaryOutput.Close(); err != nil {
		return Result{}, err
	}
	temporaryOutputClosed = true
	finalPath := filepath.Join(outputDir, outputName)
	for attempt := 0; ; attempt++ {
		mergeOwner = manifestOutput{Name: outputName, Device: device, Inode: inode}
		if s.Artifacts != nil && request.JobID != "" {
			owners := []manifestOutput{{Name: outputName, Device: device, Inode: inode}}
			manifestPath, err = writeManifestAtWithOwners(prepared.root, outputDir, request.JobID, destination.Kind, destination.ID, []string{outputName}, owners, now(s).Add(destinationRetention(destination, s)), request.Container)
			if err != nil {
				return Result{}, err
			}
			s.Artifacts.RegisterManifest(request.JobID, manifestPath)
		}
		err = prepared.publish(temporaryName, outputName)
		if err == nil {
			mergePublished = true
			break
		}
		if !errors.Is(err, fs.ErrExist) || attempt == 99 {
			return Result{}, fmt.Errorf("publish export: %w", err)
		}
		outputName, err = prepared.outputFileName(request, sourceName, 0, now(s))
		if err != nil {
			return Result{}, err
		}
		finalPath = filepath.Join(outputDir, outputName)
	}
	info, err := prepared.root.Lstat(outputName)
	if err != nil {
		return Result{}, err
	}
	if !info.Mode().IsRegular() || !os.SameFile(temporaryInfo, info) {
		return Result{}, errors.New("published output changed")
	}
	result := newResult(request.Container, destination, s, appliedStrategies)
	result.OutputName = outputName
	result.SizeBytes = info.Size()
	applyResultMetadata(&result, request.CutStrategy, segments, keyframes, hybridInterior)
	if s.Artifacts != nil {
		s.Artifacts.Put(request.JobID, []Artifact{{Path: finalPath, Name: outputName, Kind: destination.Kind, Expires: result.RetainUntil}})
	}
	manifestPublished = true
	mergeCommitted = true
	return result, nil
}

func seconds(milliseconds int64) string {
	return strconv.FormatFloat(float64(milliseconds)/1000, 'f', 3, 64)
}

func requestSourceName(source *os.File, request Request) string {
	if request.SourceName != "" {
		return request.SourceName
	}
	if source == nil {
		return ""
	}
	return source.Name()
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
