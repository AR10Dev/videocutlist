// Package adapters implements application ports with infrastructure components.
package adapters

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"

	"editapp/application"
	"editapp/domain"
	"editapp/infrastructure/cache"
	exporter "editapp/infrastructure/export"
	"editapp/infrastructure/ffmpeg"
	"editapp/infrastructure/media/index"
	"editapp/infrastructure/store"
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
func (m MediaCatalog) Get(ctx context.Context, id string) (application.Media, error) {
	record, err := m.Store.Get(ctx, id)
	if err != nil {
		return application.Media{}, err
	}
	return media(record.Media), nil
}
func (m MediaCatalog) Refresh(ctx context.Context) error { return m.Scanner.Refresh(ctx, m.Store) }
func (m MediaCatalog) Preview(ctx context.Context, request application.PreviewSpec) (domain.PreviewSpec, error) {
	source, item, err := m.Scanner.Open(ctx, m.Store, request.MediaID)
	if err != nil {
		return domain.PreviewSpec{}, err
	}
	if err := source.Close(); err != nil {
		return domain.PreviewSpec{}, err
	}
	return preview(item, request), nil
}
func media(item index.Media) application.Media {
	streams := map[string]any{}
	if item.Metadata.Video != nil {
		streams["video"] = item.Metadata.Video
	}
	if item.Metadata.Audio != nil {
		streams["audio"] = item.Metadata.Audio
	}
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

func (p ProjectRepository) Get(ctx context.Context, owner, id string) (application.ProjectRecord, error) {
	record, err := p.Store.Get(ctx, owner, id)
	if err != nil {
		return application.ProjectRecord{}, err
	}
	return project(record)
}
func (p ProjectRepository) Save(ctx context.Context, owner, id string, document domain.Document) (application.ProjectRecord, error) {
	data, err := json.Marshal(document)
	if err != nil {
		return application.ProjectRecord{}, err
	}
	record, err := p.Store.Save(ctx, owner, id, document.Revision, string(data))
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

type ExportJobs struct{ Store *store.JobStore }

func (e ExportJobs) Create(ctx context.Context, job application.ExportJob) (application.ExportJob, error) {
	record, err := e.Store.Create(ctx, store.ExportJob{ID: job.ID, OwnerLogin: job.Owner, ProjectID: job.ProjectID, ProjectRevision: job.ProjectRevision, RequestJSON: job.RequestJSON})
	if err != nil {
		return application.ExportJob{}, err
	}
	return exportJob(record), nil
}
func (e ExportJobs) Get(ctx context.Context, owner, id string) (application.ExportJob, error) {
	record, err := e.Store.Get(ctx, owner, id)
	if err != nil {
		return application.ExportJob{}, err
	}
	return exportJob(record), nil
}
func (e ExportJobs) Cancel(ctx context.Context, owner, id string) (application.ExportJob, error) {
	record, err := e.Store.Cancel(ctx, owner, id)
	if errors.Is(err, store.ErrJobState) {
		return application.ExportJob{}, application.ErrJobState
	}
	if err != nil {
		return application.ExportJob{}, err
	}
	return exportJob(record), nil
}
func exportJob(record store.ExportJob) application.ExportJob {
	var result *string
	if record.ResultJSON.Valid {
		value := record.ResultJSON.String
		result = &value
	}
	return application.ExportJob{ID: record.ID, Owner: record.OwnerLogin, ProjectID: record.ProjectID, ProjectRevision: record.ProjectRevision, State: string(record.State), RequestJSON: record.RequestJSON, ResultJSON: result, CreatedAt: record.CreatedAt, UpdatedAt: record.UpdatedAt}
}

type ExportExecutor struct {
	Jobs        *store.JobStore
	Scanner     *index.Scanner
	Media       *store.MediaStore
	Coordinator exporter.Coordinator
}

func NewExportExecutor(jobs *store.JobStore, scanner *index.Scanner, media *store.MediaStore, service exporter.Service) ExportExecutor {
	return ExportExecutor{Jobs: jobs, Scanner: scanner, Media: media, Coordinator: exporter.Coordinator{Jobs: jobs, Exporter: service}}
}
func (e ExportExecutor) Execute(ctx context.Context, owner, id string, document domain.Document) error {
	source, _, err := e.Scanner.Open(ctx, e.Media, document.MediaID)
	if err != nil {
		_, _ = e.Jobs.Start(context.Background(), owner, id)
		_, _ = e.Jobs.Fail(context.Background(), owner, id, "media_unavailable")
		return err
	}
	defer source.Close()
	file, ok := source.(*os.File)
	if !ok {
		_, _ = e.Jobs.Start(context.Background(), owner, id)
		_, _ = e.Jobs.Fail(context.Background(), owner, id, "media_unavailable")
		return errors.New("media source is not a file")
	}
	_, err = e.Coordinator.Execute(ctx, owner, id, file, document)
	return err
}
