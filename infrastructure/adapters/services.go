// Package adapters implements application ports with infrastructure components.
package adapters

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"videocutlist/application"
	"videocutlist/domain"
	"videocutlist/infrastructure/cache"
	exporter "videocutlist/infrastructure/export"
	"videocutlist/infrastructure/ffmpeg"
	"videocutlist/infrastructure/media/index"
	"videocutlist/infrastructure/store"
)

type MediaCatalog struct {
	Scanner *index.Scanner
	Store   *store.MediaStore
}

func (m MediaCatalog) List(ctx context.Context, cursor string, limit int) (application.MediaPage, error) {
	page, err := m.Store.List(ctx, cursor, limit)
	if err != nil {
		return application.MediaPage{}, err
	}
	result := application.MediaPage{Items: make([]application.Media, 0, len(page.Items))}
	for _, item := range page.Items {
		result.Items = append(result.Items, media(item))
	}
	if page.NextCursor != "" {
		result.NextCursor = &page.NextCursor
	}
	return result, nil
}
func (m MediaCatalog) Browse(ctx context.Context, folderID, cursor string, limit int) (application.FolderPage, error) {
	folders, items, next, err := m.Store.Browse(ctx, folderID, cursor, limit)
	if err != nil {
		return application.FolderPage{}, err
	}
	page := application.FolderPage{Folders: make([]application.FolderNode, 0, len(folders)), Items: make([]application.Media, 0, len(items))}
	for _, folder := range folders {
		page.Folders = append(page.Folders, application.FolderNode{ID: folder.ID, Label: folder.Label})
	}
	for _, item := range items {
		page.Items = append(page.Items, media(item))
	}
	if next != "" {
		page.NextCursor = &next
	}
	return page, nil
}
func (m MediaCatalog) Get(ctx context.Context, id string) (application.Media, error) {
	record, err := m.Store.Get(ctx, id)
	if err != nil {
		return application.Media{}, err
	}
	return media(record.Media), nil
}
func (m MediaCatalog) Refresh(ctx context.Context) error         { return m.Scanner.Refresh(ctx, m.Store) }
func (m MediaCatalog) RootStatuses() map[string]index.RootStatus { return m.Scanner.RootStatuses() }
func (m MediaCatalog) Preview(ctx context.Context, request application.PreviewSpec) (domain.PreviewSpec, error) {
	item, err := m.Store.Get(ctx, request.MediaID)
	if err != nil {
		return domain.PreviewSpec{}, err
	}
	return preview(item.Media, request), nil
}
func media(item index.Media) application.Media {
	streams := map[string]any{}
	if item.Metadata.Video != nil {
		streams["video"] = item.Metadata.Video
	}
	if item.Metadata.Audio != nil {
		streams["audio"] = item.Metadata.Audio
	}
	streams["tracks"] = item.Metadata.Streams
	return application.Media{ID: item.ID, Name: item.Name, DurationMS: item.Metadata.DurationMS, SizeBytes: item.SizeBytes, Container: item.Metadata.Container, Streams: streams, ETag: index.SourceFingerprint(item)}
}
func preview(item index.Media, request application.PreviewSpec) domain.PreviewSpec {
	return domain.PreviewSpec{MediaID: item.ID, SizeBytes: item.SizeBytes, MtimeNS: item.MtimeNS, StartMS: request.StartMS, DurationMS: request.WindowMS, OffsetMS: request.OffsetMS, Width: 1280, Height: 720, FPS: 30, Audio: !request.Mute, Encoder: "software-h264-v1", EncoderImpl: "libx264"}
}

type PreviewCache struct{ Store *cache.Store }

func (p PreviewCache) Open(ctx context.Context, key string, validator application.Validator) (io.ReadCloser, error) {
	return p.Store.Open(ctx, key, cache.Validator(validator))
}
func (p PreviewCache) Begin(key string) (application.PreviewPartial, error) {
	return p.Store.Begin(key)
}

type PreviewRunner struct {
	Scanner *index.Scanner
	Media   *store.MediaStore
	FFmpeg  ffmpeg.Runner
}

func (r PreviewRunner) Start(ctx context.Context, spec domain.PreviewSpec) (*application.RunningPreview, error) {
	source, item, err := r.Scanner.Open(ctx, r.Media, spec.MediaID)
	if err != nil {
		return nil, err
	}
	defer source.Close()
	if item.ID != spec.MediaID || item.SizeBytes != spec.SizeBytes || item.MtimeNS != spec.MtimeNS {
		return nil, index.ErrSourceChanged
	}
	file, ok := source.(*os.File)
	if !ok {
		return nil, errors.New("media source is not a file")
	}
	return r.FFmpeg.Start(ctx, file, spec)
}

type ProjectRepository struct{ Store *store.ProjectStore }

func (p ProjectRepository) Get(ctx context.Context, id string) (application.ProjectRecord, error) {
	record, err := p.Store.Get(ctx, id)
	if err != nil {
		return application.ProjectRecord{}, err
	}
	return project(record)
}
func (p ProjectRepository) Save(ctx context.Context, id string, document domain.Document) (application.ProjectRecord, error) {
	data, err := json.Marshal(document)
	if err != nil {
		return application.ProjectRecord{}, err
	}
	record, err := p.Store.Save(ctx, id, document.Revision, string(data))
	if err != nil {
		return application.ProjectRecord{}, err
	}
	return project(record)
}
func project(record store.ProjectRecord) (application.ProjectRecord, error) {
	var document domain.Document
	if err := json.Unmarshal([]byte(record.DocumentJSON), &document); err != nil {
		return application.ProjectRecord{}, err
	}
	document.Revision = record.Revision
	return application.ProjectRecord{Document: document, UpdatedAt: record.UpdatedAt}, nil
}

type ExportExecutor struct {
	Jobs        *store.JobStore
	Scanner     *index.Scanner
	Media       *store.MediaStore
	Coordinator exporter.Coordinator
	Settings    *store.RuntimeSettingsState
}

func NewExportExecutor(jobs *store.JobStore, scanner *index.Scanner, media *store.MediaStore, service exporter.Service) ExportExecutor {
	return ExportExecutor{Jobs: jobs, Scanner: scanner, Media: media, Coordinator: exporter.Coordinator{Jobs: jobs, Exporter: service}}
}
func (e ExportExecutor) Preflight(ctx context.Context, projectID string, project application.Project, input application.ExportInput) (application.ExportPreflight, error) {
	source, _, err := e.Scanner.Open(ctx, e.Media, project.MediaID)
	if err != nil {
		return application.ExportPreflight{}, err
	}
	defer source.Close()
	file, ok := source.(*os.File)
	if !ok {
		return application.ExportPreflight{}, errors.New("media source is not a file")
	}
	service := e.Coordinator.Exporter
	if e.Settings != nil {
		applyRuntimeSettings(&service, e.Settings.Snapshot())
	}
	result, err := service.Preflight(ctx, file, exporter.Request{Mode: input.Mode, Selection: input.Selection, StreamIndexes: input.StreamIndexes, CutStrategy: input.CutStrategy, Container: input.Container, DestinationID: input.DestinationID, FilenameTemplate: input.FilenameTemplate})
	if err != nil {
		return application.ExportPreflight{}, err
	}
	findings := make([]application.ExportFinding, len(result.Findings))
	for i, finding := range result.Findings {
		findings[i] = application.ExportFinding{Severity: finding.Severity, Code: finding.Code, Message: finding.Message, StreamIndex: finding.StreamIndex}
	}
	return application.ExportPreflight{Allowed: result.Allowed, Selection: result.Selection, Findings: findings}, nil
}

func (e ExportExecutor) Download(ctx context.Context, jobID string, position int) (io.ReadCloser, string, error) {
	job, err := e.Jobs.Get(ctx, jobID)
	if err != nil || job.State != store.JobSucceeded || e.Coordinator.Exporter.Artifacts == nil {
		return nil, "", store.ErrJobNotFound
	}
	var request exporter.Request
	var result exporter.Result
	if json.Unmarshal([]byte(job.RequestJSON), &request) != nil || !job.ResultJSON.Valid || json.Unmarshal([]byte(job.ResultJSON.String), &result) != nil || result.DestinationKind == exporter.KindSourceAdjacent {
		return nil, "", store.ErrJobNotFound
	}
	destination := exporter.Destination{ID: "download", Kind: exporter.KindDownload, Root: e.Coordinator.Exporter.OutputDir}
	for _, candidate := range e.Coordinator.Exporter.Destinations {
		if candidate.ID == result.DestinationID {
			destination = candidate
			break
		}
	}
	if destination.Root == "" {
		return nil, "", store.ErrJobNotFound
	}
	names := result.OutputNames
	if result.OutputName != "" {
		names = []string{result.OutputName}
	}
	if position < 0 || position >= len(names) {
		return nil, "", store.ErrJobNotFound
	}
	values := make([]exporter.Artifact, len(names))
	for i, name := range names {
		values[i] = exporter.Artifact{Path: filepath.Join(destination.Root, name), Name: name, Kind: result.DestinationKind, Expires: result.RetainUntil}
	}
	e.Coordinator.Exporter.Artifacts.Put(jobID, values)
	file, artifact, err := e.Coordinator.Exporter.Artifacts.Open(jobID, position, time.Now().UTC())
	if err != nil {
		return nil, "", err
	}
	return file, artifact.Name, nil
}

func (e ExportExecutor) ExecuteBatchSnapshot(ctx context.Context, id string, snapshot application.ExportSnapshot) error {
	source, _, err := e.Scanner.Open(ctx, e.Media, snapshot.Source.MediaID)
	if err != nil {
		return fmt.Errorf("open batch source: %w", err)
	}
	defer source.Close()
	file, ok := source.(*os.File)
	if !ok {
		return errors.New("media source is not a file")
	}
	coordinator := e.Coordinator
	if snapshot.RuntimeSettings != nil {
		applyRuntimeSettings(&coordinator.Exporter, *snapshot.RuntimeSettings)
	}
	item := snapshot.Item
	document := domain.Document{SchemaVersion: domain.ProjectSchemaVersion, Name: "Batch export", Items: []domain.ProjectItem{item}}
	_, err = coordinator.Exporter.Run(ctx, file, document, exporter.Request{
		Mode: item.ExportOptions.Mode, Selection: item.ExportOptions.Selection,
		StreamIndexes: item.ExportOptions.StreamIndexes, CutStrategy: item.ExportOptions.CutStrategy,
		Container: item.ExportOptions.Container, DestinationID: item.ExportOptions.DestinationID,
		FilenameTemplate: item.ExportOptions.FilenameTemplate, JobID: id,
	})
	return err
}

func (e ExportExecutor) Execute(ctx context.Context, id string, document domain.Document) error {
	source, _, err := e.Scanner.Open(ctx, e.Media, document.MediaID)
	if err != nil {
		stateContext := context.Background()
		_, _ = e.Jobs.Start(stateContext, id)
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) || ctx.Err() != nil {
			_, _ = e.Jobs.Cancel(stateContext, id)
		} else {
			_, _ = e.Jobs.Fail(stateContext, id, "media_unavailable")
		}
		return err
	}
	defer source.Close()
	file, ok := source.(*os.File)
	if !ok {
		_, _ = e.Jobs.Start(context.Background(), id)
		_, _ = e.Jobs.Fail(context.Background(), id, "media_unavailable")
		return errors.New("media source is not a file")
	}
	coordinator := e.Coordinator
	if e.Settings != nil {
		settings := e.Settings.Snapshot()
		if job, getErr := e.Jobs.Get(ctx, id); getErr == nil {
			var request struct {
				Settings *store.RuntimeSettings `json:"runtimeSettings"`
			}
			if json.Unmarshal([]byte(job.RequestJSON), &request) == nil && request.Settings != nil {
				settings = *request.Settings
			}
		}
		applyRuntimeSettings(&coordinator.Exporter, settings)
	}
	_, err = coordinator.Execute(ctx, id, file, document)
	return err
}

func applyRuntimeSettings(service *exporter.Service, settings store.RuntimeSettings) {
	service.Destinations = make([]exporter.Destination, len(settings.Destinations))
	for i, destination := range settings.Destinations {
		service.Destinations[i] = exporter.Destination{ID: destination.ID, Label: destination.Label, Description: destination.Description, Kind: destination.Kind, Root: destination.Root, RetentionText: destination.Retention, MediaRoot: destination.MediaRoot}
	}
}
