// Package adapters binds infrastructure implementations to application ports.
package adapters

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"sync"
	"time"

	"editapp/application"
	"editapp/domain"
	"editapp/infrastructure/cache"
	exporter "editapp/infrastructure/export"
	"editapp/infrastructure/ffmpeg"
	"editapp/infrastructure/media/index"
	"editapp/infrastructure/store"
)

type RefreshJobs struct {
	mu   sync.Mutex
	jobs map[string]ownedJob
}

type ownedJob struct {
	owner string
	job   application.Job
}

func NewRefreshJobs() *RefreshJobs { return &RefreshJobs{jobs: map[string]ownedJob{}} }

func (r *RefreshJobs) put(owner string, job application.Job) {
	r.mu.Lock()
	r.jobs[job.ID] = ownedJob{owner: owner, job: job}
	r.mu.Unlock()
}

func (r *RefreshJobs) get(owner, id string) (application.Job, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	job, ok := r.jobs[id]
	return job.job, ok && job.owner == owner
}

type MediaAdapter struct {
	Scanner *index.Scanner
	Store   *store.MediaStore
	Refresh *RefreshJobs

	mu         sync.Mutex
	refreshing bool
	refreshed  time.Time
}

func (m *MediaAdapter) List(ctx context.Context, cursor string, limit int) (application.MediaPage, error) {
	page, err := m.Store.List(ctx, cursor, limit)
	if err != nil {
		return application.MediaPage{}, err
	}
	result := application.MediaPage{Items: make([]application.Media, 0, len(page.Items))}
	for _, item := range page.Items {
		result.Items = append(result.Items, apiMedia(item))
	}
	if page.NextCursor != "" {
		result.NextCursor = &page.NextCursor
	}
	return result, nil
}

func (m *MediaAdapter) Get(ctx context.Context, id string) (application.Media, error) {
	record, err := m.Store.Get(ctx, id)
	if err != nil {
		return application.Media{}, err
	}
	return apiMedia(record.Media), nil
}

func (m *MediaAdapter) RefreshMedia(ctx context.Context, principal domain.Principal) (application.Job, error) {
	m.mu.Lock()
	if m.refreshing || !m.refreshed.IsZero() && time.Since(m.refreshed) < time.Minute {
		m.mu.Unlock()
		return application.Job{}, application.ErrBusy
	}
	m.refreshing = true
	m.mu.Unlock()
	defer func() {
		m.mu.Lock()
		m.refreshing = false
		m.refreshed = time.Now()
		m.mu.Unlock()
	}()

	started := time.Now().UTC()
	id, err := newID("j_")
	if err != nil {
		return application.Job{}, err
	}
	if err := m.Scanner.Refresh(ctx, m.Store); err != nil {
		return application.Job{}, err
	}
	job := application.Job{ID: id, Type: "media_refresh", State: string(store.JobSucceeded), Progress: 1, CreatedAt: started, UpdatedAt: time.Now().UTC()}
	m.Refresh.put(principal.Subject, job)
	return job, nil
}

func apiMedia(item index.Media) application.Media {
	streams := map[string]any{}
	if item.Metadata.Video != nil {
		streams["video"] = item.Metadata.Video
	}
	if item.Metadata.Audio != nil {
		streams["audio"] = item.Metadata.Audio
	}
	return application.Media{
		ID: item.ID, Name: item.Name, DurationMS: item.Metadata.DurationMS,
		SizeBytes: item.SizeBytes, Container: item.Metadata.Container, Streams: streams,
		ETag: index.SourceFingerprint(item),
	}
}

type PreviewAdapter struct {
	Scanner   *index.Scanner
	Media     *store.MediaStore
	Manager   *application.PreviewManager
	Cache     *cache.Store
	Validator cache.Validator
}

type PreviewCache struct{ Store *cache.Store }

func (p PreviewCache) Open(ctx context.Context, key string, validator application.Validator) (io.ReadCloser, error) {
	return p.Store.Open(ctx, key, cache.Validator(validator))
}
func (p PreviewCache) Begin(key string) (application.PreviewPartial, error) {
	return p.Store.Begin(key)
}

// PreviewRunner resolves opaque IDs beneath configured roots immediately before
// spawning FFmpeg; application code never receives a filesystem path.
type PreviewRunner struct {
	Scanner *index.Scanner
	Media   *store.MediaStore
	FFmpeg  ffmpeg.Runner
}

func (r PreviewRunner) Start(ctx context.Context, spec domain.PreviewSpec) (*application.RunningPreview, error) {
	source, _, err := r.Scanner.Open(ctx, r.Media, spec.MediaID)
	if err != nil {
		return nil, err
	}
	defer source.Close()
	file, ok := source.(*os.File)
	if !ok {
		return nil, errors.New("media source is not a file")
	}
	return r.FFmpeg.Start(ctx, file, spec)
}

func (p PreviewAdapter) Start(ctx context.Context, principal domain.Principal, request application.PreviewSpec) (application.PreviewResult, error) {
	record, err := p.Media.Get(ctx, request.MediaID)
	if err != nil {
		return application.PreviewResult{}, err
	}
	spec := previewSpec(record.Media, request)
	reader, result, err := p.Manager.Preview(ctx, principal.Subject, spec)
	if err != nil {
		return application.PreviewResult{}, err
	}
	return application.PreviewResult{
		Reader: reader, CacheStatus: string(result.Status), StartMS: request.StartMS,
		DurationMS: request.WindowMS, OffsetMS: request.OffsetMS,
	}, nil
}

func (p PreviewAdapter) Cached(ctx context.Context, request application.PreviewSpec) (bool, error) {
	record, err := p.Media.Get(ctx, request.MediaID)
	if err != nil {
		return false, err
	}
	reader, err := p.Cache.Open(ctx, domain.PreviewKey(previewSpec(record.Media, request)), p.Validator)
	if errors.Is(err, application.ErrCacheMiss) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, reader.Close()
}

func previewSpec(item index.Media, request application.PreviewSpec) domain.PreviewSpec {
	return domain.PreviewSpec{
		MediaID: item.ID, SizeBytes: item.SizeBytes, MtimeNS: item.MtimeNS,
		StartMS: request.StartMS, DurationMS: request.WindowMS, OffsetMS: request.OffsetMS,
		Width: 1280, Height: 720, FPS: 30, Audio: !request.Mute,
		Encoder: "software-h264-v1", EncoderImpl: "libx264",
	}
}

type ProjectAdapter struct{ Store *store.ProjectStore }

func (p ProjectAdapter) Get(ctx context.Context, principal domain.Principal, id string) (application.Project, error) {
	record, err := p.Store.Get(ctx, principal.Subject, id)
	if err != nil {
		return application.Project{}, err
	}
	document, err := decodeProject(record)
	if err != nil {
		return application.Project{}, err
	}
	return apiProject(id, document, record.UpdatedAt), nil
}

func (p ProjectAdapter) Save(ctx context.Context, principal domain.Principal, id string, input application.ProjectInput, duration int64) (application.Project, error) {
	if err := domain.Validate(input, duration); err != nil {
		return application.Project{}, err
	}
	data, err := json.Marshal(input)
	if err != nil {
		return application.Project{}, err
	}
	record, err := p.Store.Save(ctx, principal.Subject, id, input.Revision, string(data))
	if err != nil {
		return application.Project{}, err
	}
	document, err := decodeProject(record)
	if err != nil {
		return application.Project{}, err
	}
	return apiProject(id, document, record.UpdatedAt), nil
}

func apiProject(id string, document domain.Document, updated time.Time) application.Project {
	return application.Project{
		ID: id, UpdatedAt: updated,
		Document: document,
	}
}

func decodeProject(record store.ProjectRecord) (domain.Document, error) {
	var document domain.Document
	if err := json.Unmarshal([]byte(record.DocumentJSON), &document); err != nil {
		return domain.Document{}, err
	}
	document.Revision = record.Revision
	return document, nil
}

type ExportAdapter struct {
	Store       *store.JobStore
	Scanner     *index.Scanner
	Media       *store.MediaStore
	Coordinator exporter.Coordinator
	slots       chan struct{}
	mu          sync.Mutex
	cancel      map[string]context.CancelFunc
}

func NewExportAdapter(jobStore *store.JobStore, scanner *index.Scanner, media *store.MediaStore, service exporter.Service, limit int) *ExportAdapter {
	return &ExportAdapter{
		Store: jobStore, Scanner: scanner, Media: media,
		Coordinator: exporter.Coordinator{Jobs: jobStore, Exporter: service},
		slots:       make(chan struct{}, limit), cancel: map[string]context.CancelFunc{},
	}
}

func (e *ExportAdapter) Create(ctx context.Context, principal domain.Principal, projectID string, project application.Project, input application.ExportInput) (application.Job, error) {
	select {
	case e.slots <- struct{}{}:
	default:
		return application.Job{}, application.ErrBusy
	}
	admitted := false
	defer func() {
		if !admitted {
			<-e.slots
		}
	}()

	id, err := newID("j_")
	if err != nil {
		return application.Job{}, err
	}
	request := exporter.Request{Mode: input.Mode, CutStrategy: input.CutStrategy, Container: input.Container}
	data, err := json.Marshal(request)
	if err != nil {
		return application.Job{}, err
	}
	record, err := e.Store.Create(ctx, store.ExportJob{
		ID: id, OwnerLogin: principal.Subject, ProjectID: projectID,
		ProjectRevision: project.Revision, RequestJSON: string(data),
	})
	if err != nil {
		return application.Job{}, err
	}
	jobCtx, cancel := context.WithCancel(context.Background())
	e.mu.Lock()
	e.cancel[id] = cancel
	e.mu.Unlock()
	admitted = true
	go e.run(jobCtx, principal.Subject, id, project)
	return apiJob(record), nil
}

func (e *ExportAdapter) run(ctx context.Context, owner, id string, project application.Project) {
	defer func() { <-e.slots }()
	defer func() {
		e.mu.Lock()
		delete(e.cancel, id)
		e.mu.Unlock()
	}()
	source, _, err := e.Scanner.Open(ctx, e.Media, project.MediaID)
	if err != nil {
		_, _ = e.Store.Start(context.Background(), owner, id)
		_, _ = e.Store.Fail(context.Background(), owner, id, "media_unavailable")
		return
	}
	defer source.Close()
	file, ok := source.(*os.File)
	if !ok {
		_, _ = e.Store.Start(context.Background(), owner, id)
		_, _ = e.Store.Fail(context.Background(), owner, id, "media_unavailable")
		return
	}
	_, _ = e.Coordinator.Execute(ctx, owner, id, file, project.Document)
}

func (e *ExportAdapter) cancelJob(owner, id string) error {
	record, err := e.Store.Get(context.Background(), owner, id)
	if err != nil {
		return err
	}
	if record.State == store.JobSucceeded || record.State == store.JobFailed || record.State == store.JobCancelled {
		return nil
	}
	e.mu.Lock()
	cancel := e.cancel[id]
	e.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	_, err = e.Store.Cancel(context.Background(), owner, id)
	if errors.Is(err, store.ErrJobState) {
		return nil
	}
	return err
}

type JobAdapter struct {
	Exports *ExportAdapter
	Refresh *RefreshJobs
}

func (j JobAdapter) Get(ctx context.Context, principal domain.Principal, id string) (application.Job, error) {
	if job, ok := j.Refresh.get(principal.Subject, id); ok {
		return job, nil
	}
	record, err := j.Exports.Store.Get(ctx, principal.Subject, id)
	if err != nil {
		return application.Job{}, err
	}
	return apiJob(record), nil
}

func (j JobAdapter) Cancel(_ context.Context, principal domain.Principal, id string) error {
	if _, ok := j.Refresh.get(principal.Subject, id); ok {
		return nil
	}
	return j.Exports.cancelJob(principal.Subject, id)
}

func apiJob(record store.ExportJob) application.Job {
	progress := 0.0
	if record.State == store.JobRunning {
		progress = 0.5
	}
	if record.State == store.JobSucceeded || record.State == store.JobFailed || record.State == store.JobCancelled {
		progress = 1
	}
	var warnings []string
	if record.ResultJSON.Valid {
		var result exporter.Result
		if json.Unmarshal([]byte(record.ResultJSON.String), &result) == nil {
			for _, warning := range result.Warnings {
				warnings = append(warnings, warning.Message)
			}
		}
	}
	return application.Job{
		ID: record.ID, Type: "export", State: string(record.State), Progress: progress,
		Warnings: warnings, CreatedAt: record.CreatedAt, UpdatedAt: record.UpdatedAt,
	}
}

func newID(prefix string) (string, error) {
	var value [18]byte
	if _, err := io.ReadFull(rand.Reader, value[:]); err != nil {
		return "", fmt.Errorf("generate id: %w", err)
	}
	return prefix + base64.RawURLEncoding.EncodeToString(value[:]), nil
}
