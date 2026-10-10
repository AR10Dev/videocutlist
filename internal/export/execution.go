package export

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"path/filepath"
	"slices"
	"time"

	jobs "videocutlist/internal/jobs"
	jobqueue "videocutlist/internal/jobs/model"
	"videocutlist/internal/library/media/index"
	"videocutlist/internal/projects/model"
	settingsmodel "videocutlist/internal/settings/model"
)

// ExportSnapshot is the immutable, safe request stored for one batch child.
type ExportSnapshot struct {
	ProjectRevision int64                          `json:"projectRevision"`
	MediaLabel      string                         `json:"mediaLabel"`
	Item            model.ProjectItem              `json:"item"`
	Source          SourceSnapshot                 `json:"source"`
	RuntimeSettings *settingsmodel.RuntimeSettings `json:"runtimeSettings,omitempty"`
}

type SourceSnapshot struct {
	MediaID    string `json:"mediaId"`
	RootID     string `json:"rootId,omitempty"`
	ETag       string `json:"etag"`
	SizeBytes  int64  `json:"sizeBytes"`
	DurationMS int64  `json:"durationMs"`
}

// Executor owns export preflight, source execution, and artifact downloads.
type Executor struct {
	Jobs     *jobs.JobsStore
	Scanner  *index.Scanner
	Media    index.Catalog
	Service  Service
	Settings *settingsmodel.RuntimeSettingsState
}

// ExportDownloadService opens one completed browser-download artifact.
type ExportDownloadService interface {
	Download(context.Context, string, int) (io.ReadCloser, string, error)
}

// PreflightItems validates export requirements for project-selected immutable items.
// A nil override uses each item's persisted export options.
func (e Executor) PreflightItems(ctx context.Context, items []model.ProjectItem, override *model.ExportOptions) (PreflightResult, error) {
	if e.Scanner == nil || e.Media == nil {
		return PreflightResult{}, errors.New("preflight media dependencies are required")
	}
	service := e.service()
	result := PreflightResult{Allowed: true}
	for _, item := range items {
		file, media, location, err := e.Scanner.OpenResolved(ctx, e.Media, item.MediaID)
		if err != nil {
			return PreflightResult{}, err
		}
		options := item.ExportOptions.WithExportDefaults()
		if override != nil {
			options = *override
			options.StreamIndexes = slices.Clone(override.StreamIndexes)
		}
		request := requestForOptions(options)
		request.SourceRoot = location.RootPath
		request.SourceRelative = location.RelativePath
		request.SourceName = media.Name
		request.SourceSizeBytes = media.SizeBytes
		request.SourceMtimeNS = media.MtimeNS
		if request.Mode == "separate" && len(ResolveRanges(item.Segments, request.Selection, media.Metadata.DurationMS)) > MaxExportOutputs {
			result.Allowed = false
			result.Findings = append(result.Findings, Finding{Severity: "blocked", Code: "too_many_outputs", Message: fmt.Sprintf("Separate exports support at most %d outputs.", MaxExportOutputs)})
			_ = file.Close()
			continue
		}
		preflight, preflightErr := service.Preflight(ctx, file, request)
		closeErr := file.Close()
		if preflightErr != nil {
			return PreflightResult{}, preflightErr
		}
		if closeErr != nil {
			return PreflightResult{}, closeErr
		}
		if !preflight.Allowed {
			result.Allowed = false
		}
		for _, stream := range preflight.Selection {
			if !slices.Contains(result.Selection, stream) {
				result.Selection = append(result.Selection, stream)
			}
		}
		for _, finding := range preflight.Findings {
			if len(items) > 1 {
				finding.Message = media.Name + ": " + finding.Message
			}
			result.Findings = append(result.Findings, finding)
		}
	}
	return result, nil
}

func requestForOptions(options model.ExportOptions) Request {
	return Request{
		Mode: options.Mode, Selection: options.Selection, StreamIndexes: slices.Clone(options.StreamIndexes),
		CutStrategy: options.CutStrategy, Container: options.Container,
		DestinationID: options.DestinationID, FilenameTemplate: options.FilenameTemplate,
	}
}

func (e Executor) service() Service {
	service := e.Service
	if e.Settings != nil {
		applyRuntimeSettings(&service, e.Settings.Snapshot())
	}
	return service
}

// Download opens an output only when its durable job result and artifact state permit it.
func (e Executor) Download(ctx context.Context, jobID string, position int) (io.ReadCloser, string, error) {
	if e.Service.Artifacts == nil || e.Jobs == nil {
		return nil, "", jobqueue.ErrJobNotFound
	}
	var result Result
	job, err := e.Jobs.Get(ctx, jobID)
	if err != nil || job.Kind != jobqueue.JobExport || job.State != jobqueue.JobSucceeded || !job.ResultJSON.Valid || json.Unmarshal([]byte(job.ResultJSON.String), &result) != nil {
		return nil, "", jobqueue.ErrJobNotFound
	}
	destination, ok := e.Service.destinationForResult(result)
	if !ok || result.RetainUntil.IsZero() {
		return nil, "", jobqueue.ErrJobNotFound
	}
	names, ok := resultOutputNames(result)
	if !ok || position < 0 || position >= len(names) {
		return nil, "", jobqueue.ErrJobNotFound
	}
	artifacts := make([]Artifact, len(names))
	for i, name := range names {
		artifacts[i] = Artifact{Path: filepath.Join(destination.Root, name), Name: name, Kind: result.DestinationKind, Expires: result.RetainUntil}
	}
	e.Service.Artifacts.Put(jobID, artifacts)
	file, artifact, err := e.Service.Artifacts.Open(jobID, position, time.Now().UTC())
	if err != nil {
		return nil, "", err
	}
	return file, artifact.Name, nil
}

func resultOutputNames(result Result) ([]string, bool) {
	if result.OutputName != "" {
		if len(result.OutputNames) != 0 || !safeArtifactName(result.OutputName) {
			return nil, false
		}
		return []string{result.OutputName}, true
	}
	if len(result.OutputNames) == 0 || len(result.OutputNames) > MaxExportOutputs {
		return nil, false
	}
	for _, name := range result.OutputNames {
		if !safeArtifactName(name) {
			return nil, false
		}
	}
	return result.OutputNames, true
}

func safeArtifactName(name string) bool {
	if name == "" || name == "." || name == ".." || len(name) > 255 || filepath.Base(name) != name {
		return false
	}
	for _, r := range name {
		if (r < 'a' || r > 'z') && (r < 'A' || r > 'Z') && (r < '0' || r > '9') && r != '.' && r != '-' && r != '_' {
			return false
		}
	}
	return true
}

// RunSnapshot validates the resolved source identity before execution and JSON persistence.
func (e Executor) RunSnapshot(ctx context.Context, id string, snapshot ExportSnapshot) (resultJSON string, err error) {
	if e.Scanner == nil || e.Media == nil {
		return "", errors.New("export source dependencies are required")
	}
	file, media, location, err := e.Scanner.OpenResolved(ctx, e.Media, snapshot.Source.MediaID)
	if err != nil {
		return "", fmt.Errorf("open batch source: %w", err)
	}
	defer func() { err = closeBatchSource(err, file) }()
	service := e.Service
	if snapshot.RuntimeSettings != nil {
		applyRuntimeSettings(&service, *snapshot.RuntimeSettings)
	}
	item := snapshot.Item
	item.ExportOptions = item.ExportOptions.WithExportDefaults()
	document := model.Document{SchemaVersion: model.ProjectSchemaVersion, Name: "Batch export", Items: []model.ProjectItem{item}}
	options := item.ExportOptions
	result, err := service.Run(ctx, file, document, Request{
		Mode: options.Mode, Selection: options.Selection,
		StreamIndexes: slices.Clone(options.StreamIndexes), CutStrategy: options.CutStrategy,
		Container: options.Container, DestinationID: options.DestinationID,
		FilenameTemplate: options.FilenameTemplate, JobID: id,
		SourceRoot: location.RootPath, SourceRelative: location.RelativePath, SourceName: media.Name,
		SourceSizeBytes: media.SizeBytes, SourceMtimeNS: media.MtimeNS,
	})
	if err != nil {
		return "", err
	}
	encoded, err := json.Marshal(result)
	return string(encoded), err
}

func closeBatchSource(primary error, source io.Closer) error {
	if closeErr := source.Close(); closeErr != nil && primary != nil {
		return errors.Join(primary, fmt.Errorf("close batch source: %w", closeErr))
	}
	return primary
}

func applyRuntimeSettings(service *Service, settings settingsmodel.RuntimeSettings) {
	service.Destinations = make([]Destination, len(settings.Destinations))
	for i, destination := range settings.Destinations {
		retention, _ := time.ParseDuration(destination.Retention)
		service.Destinations[i] = Destination{ID: destination.ID, Label: destination.Label, Description: destination.Description, Kind: destination.Kind, Root: destination.Root, Retention: retention, RetentionText: destination.Retention, MediaRoot: destination.MediaRoot}
	}
}

var _ ExportDownloadService = Executor{}
