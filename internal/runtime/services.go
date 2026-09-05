// Package runtime composes feature infrastructure at the executable boundary.
package runtime

import (
	"archive/zip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"videocutlist/internal/db"
	exporter "videocutlist/internal/export"
	jobqueue "videocutlist/internal/jobs"
	"videocutlist/internal/library/media/index"
	"videocutlist/internal/preview/cache"
	"videocutlist/internal/preview/ffmpeg"
	"videocutlist/internal/projects"
	"videocutlist/internal/projects/model"
)

type MediaCatalog struct {
	Scanner *index.Scanner
	Store   *store.MediaStore
}

func (m MediaCatalog) List(ctx context.Context, cursor string, limit int) (projects.MediaPage, error) {
	page, err := m.Store.List(ctx, cursor, limit)
	if err != nil {
		return projects.MediaPage{}, err
	}
	result := projects.MediaPage{Items: make([]projects.Media, 0, len(page.Items))}
	for _, item := range page.Items {
		result.Items = append(result.Items, media(item))
	}
	if page.NextCursor != "" {
		result.NextCursor = &page.NextCursor
	}
	return result, nil
}
func (m MediaCatalog) Browse(ctx context.Context, folderID, cursor string, limit int) (projects.FolderPage, error) {
	folders, items, next, err := m.Store.Browse(ctx, folderID, cursor, limit)
	if err != nil {
		return projects.FolderPage{}, err
	}
	page := projects.FolderPage{Folders: make([]projects.FolderNode, 0, len(folders)), Items: make([]projects.Media, 0, len(items))}
	for _, folder := range folders {
		page.Folders = append(page.Folders, projects.FolderNode{ID: folder.ID, Label: folder.Label})
	}
	for _, item := range items {
		page.Items = append(page.Items, media(item))
	}
	if next != "" {
		page.NextCursor = &next
	}
	return page, nil
}
func (m MediaCatalog) Get(ctx context.Context, id string) (projects.Media, error) {
	record, err := m.Store.Get(ctx, id)
	if err != nil {
		return projects.Media{}, err
	}
	return media(record.Media), nil
}
func (m MediaCatalog) Refresh(ctx context.Context) error         { return m.Scanner.Refresh(ctx, m.Store) }
func (m MediaCatalog) RootStatuses() map[string]index.RootStatus { return m.Scanner.RootStatuses() }
func (m MediaCatalog) Preview(ctx context.Context, request projects.PreviewSpec) (model.PreviewSpec, error) {
	item, err := m.Store.Get(ctx, request.MediaID)
	if err != nil {
		return model.PreviewSpec{}, err
	}
	return preview(item.Media, request), nil
}
func media(item index.Media) projects.Media {
	streams := map[string]any{}
	if item.Metadata.Video != nil {
		streams["video"] = item.Metadata.Video
	}
	if item.Metadata.Audio != nil {
		streams["audio"] = item.Metadata.Audio
	}
	streams["tracks"] = item.Metadata.Streams
	return projects.Media{ID: item.ID, Name: item.Name, DurationMS: item.Metadata.DurationMS, SizeBytes: item.SizeBytes, Container: item.Metadata.Container, Streams: streams, ETag: index.SourceFingerprint(item)}
}
func preview(item index.Media, request projects.PreviewSpec) model.PreviewSpec {
	return model.PreviewSpec{MediaID: item.ID, SizeBytes: item.SizeBytes, MtimeNS: item.MtimeNS, StartMS: request.StartMS, DurationMS: request.WindowMS, OffsetMS: request.OffsetMS, Width: 1280, Height: 720, FPS: 30, Audio: !request.Mute, Encoder: "software-h264-v1", EncoderImpl: "libx264"}
}

type PreviewCache struct{ Store *cache.Store }

func (p PreviewCache) Open(ctx context.Context, key string, validator projects.Validator) (io.ReadCloser, error) {
	return p.Store.Open(ctx, key, cache.Validator(validator))
}
func (p PreviewCache) Begin(key string) (projects.PreviewPartial, error) {
	return p.Store.Begin(key)
}

type PreviewRunner struct {
	Scanner *index.Scanner
	Media   *store.MediaStore
	FFmpeg  ffmpeg.Runner
}

func (r PreviewRunner) Start(ctx context.Context, spec model.PreviewSpec) (*projects.RunningPreview, error) {
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

func (p ProjectRepository) List(ctx context.Context, cursor string, limit int) ([]store.ProjectSummary, *string, error) {
	return p.Store.List(ctx, cursor, limit)
}
func (p ProjectRepository) Get(ctx context.Context, id string) (projects.ProjectRecord, error) {
	record, err := p.Store.Get(ctx, id)
	if err != nil {
		return projects.ProjectRecord{}, err
	}
	return project(record)
}
func (p ProjectRepository) Save(ctx context.Context, id string, revision int64, document model.Document) (projects.ProjectRecord, error) {
	data, err := json.Marshal(document)
	if err != nil {
		return projects.ProjectRecord{}, err
	}
	record, err := p.Store.Save(ctx, id, revision, string(data))
	if err != nil {
		return projects.ProjectRecord{}, err
	}
	return project(record)
}
func project(record store.ProjectRecord) (projects.ProjectRecord, error) {
	var document model.Document
	if err := json.Unmarshal([]byte(record.DocumentJSON), &document); err != nil {
		return projects.ProjectRecord{}, err
	}
	return projects.ProjectRecord{Document: document, Revision: record.Revision, UpdatedAt: record.UpdatedAt}, nil
}

type ExportExecutor struct {
	Jobs     *jobqueue.JobsStore
	Scanner  *index.Scanner
	Media    *store.MediaStore
	Service  exporter.Service
	Settings *store.RuntimeSettingsState
}

func NewExportExecutor(jobs *jobqueue.JobsStore, scanner *index.Scanner, media *store.MediaStore, service exporter.Service) ExportExecutor {
	return ExportExecutor{Jobs: jobs, Scanner: scanner, Media: media, Service: service}
}
func (e ExportExecutor) Preflight(ctx context.Context, _ string, project projects.Project, input projects.ExportInput) (projects.ExportPreflight, error) {
	if len(project.Items) != 1 {
		return projects.ExportPreflight{}, errors.New("preflight requires one project item")
	}
	source, _, err := e.Scanner.Open(ctx, e.Media, project.Items[0].MediaID)
	if err != nil {
		return projects.ExportPreflight{}, err
	}
	defer source.Close()
	file, ok := source.(*os.File)
	if !ok {
		return projects.ExportPreflight{}, errors.New("media source is not a file")
	}
	service := e.Service
	if e.Settings != nil {
		applyRuntimeSettings(&service, e.Settings.Snapshot())
	}
	result, err := service.Preflight(ctx, file, exporter.Request{Mode: input.Mode, Selection: input.Selection, StreamIndexes: input.StreamIndexes, CutStrategy: input.CutStrategy, Container: input.Container, DestinationID: input.DestinationID, FilenameTemplate: input.FilenameTemplate})
	if err != nil {
		return projects.ExportPreflight{}, err
	}
	findings := make([]projects.ExportFinding, len(result.Findings))
	for i, finding := range result.Findings {
		findings[i] = projects.ExportFinding{Severity: finding.Severity, Code: finding.Code, Message: finding.Message, StreamIndex: finding.StreamIndex}
	}
	return projects.ExportPreflight{Allowed: result.Allowed, Selection: result.Selection, Findings: findings}, nil
}

func (e ExportExecutor) Download(ctx context.Context, jobID string, position int) (io.ReadCloser, string, error) {
	if e.Service.Artifacts == nil || e.Jobs == nil {
		return nil, "", jobqueue.ErrJobNotFound
	}
	var result exporter.Result
	job, err := e.Jobs.Get(ctx, jobID)
	if err != nil || job.Kind != jobqueue.JobExport || job.State != jobqueue.JobSucceeded || !job.ResultJSON.Valid || json.Unmarshal([]byte(job.ResultJSON.String), &result) != nil {
		return nil, "", jobqueue.ErrJobNotFound
	}
	destination, ok := e.destinationForResult(result)
	if !ok || result.RetainUntil.IsZero() {
		return nil, "", jobqueue.ErrJobNotFound
	}
	names, ok := resultOutputNames(result)
	if !ok || position < 0 || position >= len(names) {
		return nil, "", jobqueue.ErrJobNotFound
	}
	values := make([]exporter.Artifact, len(names))
	for i, name := range names {
		values[i] = exporter.Artifact{Path: filepath.Join(destination.Root, name), Name: name, Kind: result.DestinationKind, Expires: result.RetainUntil}
	}
	e.Service.Artifacts.Put(jobID, values)
	file, artifact, err := e.Service.Artifacts.Open(jobID, position, time.Now().UTC())
	if err != nil {
		return nil, "", err
	}
	return file, artifact.Name, nil
}

const (
	maxBatchArchiveOutputs = 1000
	maxBatchArchiveBytes   = int64(4 << 30)
)

type batchArchiveOutput struct {
	jobID    string
	name     string
	position int
}

// DownloadBatch prepares a verified ZIP from completed browser-download outputs.
// The archive is linked into place only after every entry and the ZIP directory
// have been validated; cancellation removes the unpublished temporary file.
func (e ExportExecutor) DownloadBatch(ctx context.Context, batchID string) (io.ReadCloser, string, error) {
	if e.Service.Artifacts == nil || e.Jobs == nil {
		return nil, "", jobqueue.ErrJobNotFound
	}
	if file, artifact, err := e.Service.Artifacts.Open(batchID, 0, time.Now().UTC()); err == nil {
		return file, artifact.Name, nil
	}
	jobs, err := e.Jobs.ListByBatch(ctx, batchID)
	if err != nil {
		return nil, "", err
	}
	outputs := make([]batchArchiveOutput, 0)
	var expires time.Time
	archiveRoot := ""
	for _, job := range jobs {
		if err := ctx.Err(); err != nil {
			return nil, "", err
		}
		if job.Kind != jobqueue.JobExport || job.State != jobqueue.JobSucceeded || !job.ResultJSON.Valid {
			return nil, "", jobqueue.ErrJobNotFound
		}
		var result exporter.Result
		if json.Unmarshal([]byte(job.ResultJSON.String), &result) != nil || result.DestinationKind != exporter.KindDownload || result.RetainUntil.IsZero() {
			return nil, "", jobqueue.ErrJobNotFound
		}
		destination, ok := e.destinationForResult(result)
		if !ok {
			return nil, "", jobqueue.ErrJobNotFound
		}
		if archiveRoot == "" {
			archiveRoot = destination.Root
		}
		names, ok := resultOutputNames(result)
		if !ok || len(names) == 0 || len(outputs)+len(names) > maxBatchArchiveOutputs {
			return nil, "", exporter.ErrOutputUnavailable
		}
		if expires.IsZero() || result.RetainUntil.Before(expires) {
			expires = result.RetainUntil
		}
		for position, name := range names {
			outputs = append(outputs, batchArchiveOutput{jobID: job.ID, name: name, position: position})
		}
	}
	if len(outputs) == 0 || archiveRoot == "" || !expires.After(time.Now().UTC()) {
		return nil, "", exporter.ErrOutputUnavailable
	}
	return e.prepareBatchArchive(ctx, batchID, archiveRoot, outputs, expires)
}

func (e ExportExecutor) prepareBatchArchive(ctx context.Context, batchID, archiveRoot string, outputs []batchArchiveOutput, expires time.Time) (io.ReadCloser, string, error) {
	temporary, err := os.CreateTemp(archiveRoot, ".videocutlist-batch-*.zip")
	if err != nil {
		return nil, "", exporter.ErrOutputUnavailable
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	archiveWriter := zip.NewWriter(temporary)
	usedNames := make(map[string]int, len(outputs))
	var total int64
	for _, output := range outputs {
		if err := ctx.Err(); err != nil {
			_ = archiveWriter.Close()
			_ = temporary.Close()
			return nil, "", err
		}
		file, name, err := e.Download(ctx, output.jobID, output.position)
		if err != nil {
			_ = archiveWriter.Close()
			_ = temporary.Close()
			return nil, "", exporter.ErrOutputUnavailable
		}
		info, statOK := file.(interface{ Stat() (os.FileInfo, error) })
		if !statOK {
			_ = file.Close()
			_ = archiveWriter.Close()
			_ = temporary.Close()
			return nil, "", exporter.ErrOutputUnavailable
		}
		fileInfo, statErr := info.Stat()
		if statErr != nil || fileInfo.Size() < 0 || fileInfo.Size() > maxBatchArchiveBytes-total {
			_ = file.Close()
			_ = archiveWriter.Close()
			_ = temporary.Close()
			return nil, "", exporter.ErrOutputUnavailable
		}
		entryName := uniqueBatchArchiveName(name, usedNames)
		header := &zip.FileHeader{Name: entryName, Method: zip.Store, UncompressedSize64: uint64(fileInfo.Size())}
		entry, err := archiveWriter.CreateHeader(header)
		if err == nil {
			var copied int64
			copied, err = io.Copy(entry, contextReader{ctx: ctx, reader: file})
			if err == nil && copied != fileInfo.Size() {
				err = exporter.ErrOutputUnavailable
			}
			total += copied
		}
		closeErr := file.Close()
		if err == nil {
			err = closeErr
		}
		if err != nil {
			_ = archiveWriter.Close()
			_ = temporary.Close()
			return nil, "", err
		}
	}
	if err := ctx.Err(); err != nil {
		_ = archiveWriter.Close()
		_ = temporary.Close()
		return nil, "", err
	}
	if err := archiveWriter.Close(); err != nil {
		_ = temporary.Close()
		return nil, "", exporter.ErrOutputUnavailable
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return nil, "", exporter.ErrOutputUnavailable
	}
	if err := temporary.Close(); err != nil {
		return nil, "", exporter.ErrOutputUnavailable
	}
	if err := validateBatchArchive(ctx, temporaryPath, len(outputs), total); err != nil {
		return nil, "", err
	}
	name, path, err := publishBatchArchive(temporaryPath, archiveRoot, batchID)
	if err != nil {
		return nil, "", err
	}
	e.Service.Artifacts.Put(batchID, []exporter.Artifact{{Path: path, Name: name, Kind: exporter.KindDownload, Expires: expires}})
	file, artifact, err := e.Service.Artifacts.Open(batchID, 0, time.Now().UTC())
	if err != nil {
		_ = os.Remove(path)
		return nil, "", err
	}
	return file, artifact.Name, nil
}

func validateBatchArchive(ctx context.Context, path string, count int, expectedBytes int64) error {
	file, err := os.Open(path)
	if err != nil {
		return exporter.ErrOutputUnavailable
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() == 0 || info.Size() > maxBatchArchiveBytes {
		return exporter.ErrOutputUnavailable
	}
	archive, err := zip.NewReader(file, info.Size())
	if err != nil || len(archive.File) != count {
		return exporter.ErrOutputUnavailable
	}
	var total int64
	for _, entry := range archive.File {
		if err := ctx.Err(); err != nil {
			return err
		}
		if !validBatchArchiveName(entry.Name) || entry.FileInfo().IsDir() || entry.UncompressedSize64 > uint64(maxBatchArchiveBytes-total) {
			return exporter.ErrOutputUnavailable
		}
		reader, err := entry.Open()
		if err != nil {
			return exporter.ErrOutputUnavailable
		}
		copied, copyErr := io.Copy(io.Discard, contextReader{ctx: ctx, reader: reader})
		closeErr := reader.Close()
		if copyErr != nil {
			return copyErr
		}
		if closeErr != nil || copied != int64(entry.UncompressedSize64) {
			return exporter.ErrOutputUnavailable
		}
		total += copied
	}
	if total != expectedBytes {
		return exporter.ErrOutputUnavailable
	}
	return nil
}

func publishBatchArchive(temporaryPath, archiveRoot, batchID string) (string, string, error) {
	token := "batch"
	if validBatchArchiveToken(batchID) {
		token = batchID
	}
	for attempt := range 100 {
		name := "videocutlist-clips-" + token + ".zip"
		if attempt > 0 {
			name = fmt.Sprintf("videocutlist-clips-%s-%d.zip", token, attempt)
		}
		path := filepath.Join(archiveRoot, name)
		if err := os.Link(temporaryPath, path); err == nil {
			return name, path, nil
		} else if !errors.Is(err, os.ErrExist) {
			return "", "", exporter.ErrOutputUnavailable
		}
	}
	return "", "", exporter.ErrOutputUnavailable
}

func uniqueBatchArchiveName(name string, used map[string]int) string {
	count := used[name]
	used[name] = count + 1
	if count == 0 {
		return name
	}
	extension := filepath.Ext(name)
	stem := strings.TrimSuffix(name, extension)
	for suffix := count + 1; ; suffix++ {
		candidate := fmt.Sprintf("%s-%d%s", stem, suffix, extension)
		if used[candidate] == 0 {
			used[candidate] = 1
			return candidate
		}
	}
}

func validBatchArchiveName(name string) bool {
	if name == "" || name == "." || name == ".." || len(name) > 255 || filepath.Base(name) != name {
		return false
	}
	for _, r := range name {
		if !((r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '.' || r == '-' || r == '_') {
			return false
		}
	}
	return true
}

func validBatchArchiveToken(value string) bool {
	if value == "" {
		return false
	}
	for _, r := range value {
		if !((r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_') {
			return false
		}
	}
	return true
}

type contextReader struct {
	ctx    context.Context
	reader io.Reader
}

func (r contextReader) Read(p []byte) (int, error) {
	select {
	case <-r.ctx.Done():
		return 0, r.ctx.Err()
	default:
		return r.reader.Read(p)
	}
}

func (e ExportExecutor) destinationForResult(result exporter.Result) (exporter.Destination, bool) {
	destination := exporter.Destination{ID: "download", Kind: exporter.KindDownload, Root: e.Service.OutputDir}
	for _, candidate := range e.Service.Destinations {
		if candidate.ID == result.DestinationID {
			destination = candidate
			break
		}
	}
	return destination, destination.Root != "" && destination.Kind == result.DestinationKind && result.DestinationKind == exporter.KindDownload
}

func resultOutputNames(result exporter.Result) ([]string, bool) {
	if result.OutputName != "" {
		if len(result.OutputNames) != 0 || !validBatchArchiveName(result.OutputName) {
			return nil, false
		}
		return []string{result.OutputName}, true
	}
	if len(result.OutputNames) == 0 || len(result.OutputNames) > maxBatchArchiveOutputs {
		return nil, false
	}
	for _, name := range result.OutputNames {
		if !validBatchArchiveName(name) {
			return nil, false
		}
	}
	return result.OutputNames, true
}

func (e ExportExecutor) ExecuteBatchSnapshot(ctx context.Context, id string, snapshot projects.ExportSnapshot) (string, error) {
	source, _, err := e.Scanner.Open(ctx, e.Media, snapshot.Source.MediaID)
	if err != nil {
		return "", fmt.Errorf("open batch source: %w", err)
	}
	defer source.Close()
	file, ok := source.(*os.File)
	if !ok {
		return "", errors.New("media source is not a file")
	}
	service := e.Service
	if snapshot.RuntimeSettings != nil {
		applyRuntimeSettings(&service, *snapshot.RuntimeSettings)
	}
	item := snapshot.Item
	document := model.Document{SchemaVersion: model.ProjectSchemaVersion, Name: "Batch export", Items: []model.ProjectItem{item}}
	result, err := service.Run(ctx, file, document, exporter.Request{
		Mode: item.ExportOptions.Mode, Selection: item.ExportOptions.Selection,
		StreamIndexes: item.ExportOptions.StreamIndexes, CutStrategy: item.ExportOptions.CutStrategy,
		Container: item.ExportOptions.Container, DestinationID: item.ExportOptions.DestinationID,
		FilenameTemplate: item.ExportOptions.FilenameTemplate, JobID: id,
	})
	if err != nil {
		return "", err
	}
	encoded, err := json.Marshal(result)
	return string(encoded), err
}

func applyRuntimeSettings(service *exporter.Service, settings store.RuntimeSettings) {
	service.Destinations = make([]exporter.Destination, len(settings.Destinations))
	for i, destination := range settings.Destinations {
		service.Destinations[i] = exporter.Destination{ID: destination.ID, Label: destination.Label, Description: destination.Description, Kind: destination.Kind, Root: destination.Root, RetentionText: destination.Retention, MediaRoot: destination.MediaRoot}
	}
}
