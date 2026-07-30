// Package app wires domain services to the HTTP-shaped adapter interfaces.
package app

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

	"editapp/internal/api"
	"editapp/internal/cache"
	"editapp/internal/contracts"
	exporter "editapp/internal/export"
	"editapp/internal/jobs"
	"editapp/internal/media/index"
	"editapp/internal/projects"
	"editapp/internal/store"
)

type RefreshJobs struct {
	mu   sync.Mutex
	jobs map[string]ownedJob
}

type ownedJob struct {
	owner string
	job   api.Job
}

func NewRefreshJobs() *RefreshJobs { return &RefreshJobs{jobs: map[string]ownedJob{}} }

func (r *RefreshJobs) put(owner string, job api.Job) {
	r.mu.Lock()
	r.jobs[job.ID] = ownedJob{owner: owner, job: job}
	r.mu.Unlock()
}

func (r *RefreshJobs) get(owner, id string) (api.Job, bool) {
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

func (m *MediaAdapter) List(ctx context.Context, cursor string, limit int) (api.MediaPage, error) {
	page, err := m.Store.List(ctx, cursor, limit)
	if err != nil {
		return api.MediaPage{}, err
	}
	result := api.MediaPage{Items: make([]api.Media, 0, len(page.Items))}
	for _, item := range page.Items {
		result.Items = append(result.Items, apiMedia(item))
	}
	if page.NextCursor != "" {
		result.NextCursor = &page.NextCursor
	}
	return result, nil
}

func (m *MediaAdapter) Get(ctx context.Context, id string) (api.Media, error) {
	record, err := m.Store.Get(ctx, id)
	if err != nil {
		return api.Media{}, err
	}
	return apiMedia(record.Media), nil
}

func (m *MediaAdapter) RefreshMedia(ctx context.Context, owner string) (api.Job, error) {
	m.mu.Lock()
	if m.refreshing || !m.refreshed.IsZero() && time.Since(m.refreshed) < time.Minute {
		m.mu.Unlock()
		return api.Job{}, api.ErrBusy
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
		return api.Job{}, err
	}
	if err := m.Scanner.Refresh(ctx, m.Store); err != nil {
		return api.Job{}, err
	}
	job := api.Job{ID: id, Type: "media_refresh", State: string(store.JobSucceeded), Progress: 1, CreatedAt: started, UpdatedAt: time.Now().UTC()}
	m.Refresh.put(owner, job)
	return job, nil
}

func apiMedia(item index.Media) api.Media {
	streams := map[string]any{}
	if item.Metadata.Video != nil {
		streams["video"] = item.Metadata.Video
	}
	if item.Metadata.Audio != nil {
		streams["audio"] = item.Metadata.Audio
	}
	return api.Media{
		ID: item.ID, Name: item.Name, DurationMS: item.Metadata.DurationMS,
		SizeBytes: item.SizeBytes, Container: item.Metadata.Container, Streams: streams,
		ETag: index.SourceFingerprint(item),
	}
}

type PreviewAdapter struct {
	Scanner   *index.Scanner
	Media     *store.MediaStore
	Manager   *jobs.PreviewManager
	Cache     *cache.Store
	Validator cache.Validator
}

func (p PreviewAdapter) Start(ctx context.Context, user string, request api.PreviewSpec) (api.PreviewResult, error) {
	source, item, err := p.Scanner.Open(ctx, p.Media, request.MediaID)
	if err != nil {
		return api.PreviewResult{}, err
	}
	defer source.Close()
	file, ok := source.(*os.File)
	if !ok {
		return api.PreviewResult{}, errors.New("media source is not a file")
	}
	spec := previewSpec(file, item, request)
	reader, result, err := p.Manager.Preview(ctx, user, spec)
	if err != nil {
		return api.PreviewResult{}, err
	}
	return api.PreviewResult{
		Reader: reader, CacheStatus: string(result.Status), StartMS: request.StartMS,
		DurationMS: request.WindowMS, OffsetMS: request.OffsetMS,
	}, nil
}

func (p PreviewAdapter) Cached(ctx context.Context, request api.PreviewSpec) (bool, error) {
	record, err := p.Media.Get(ctx, request.MediaID)
	if err != nil {
		return false, err
	}
	reader, err := p.Cache.Open(ctx, cache.Key(previewSpec(nil, record.Media, request)), p.Validator)
	if errors.Is(err, cache.ErrMiss) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, reader.Close()
}

func previewSpec(source *os.File, item index.Media, request api.PreviewSpec) contracts.PreviewSpec {
	return contracts.PreviewSpec{
		Source: source, MediaID: item.ID, SizeBytes: item.SizeBytes, MtimeNS: item.MtimeNS,
		StartMS: request.StartMS, DurationMS: request.WindowMS, OffsetMS: request.OffsetMS,
		Width: 1280, Height: 720, FPS: 30, Audio: !request.Mute,
		Encoder: "software-h264-v1", EncoderImpl: "libx264",
	}
}

type ProjectAdapter struct {
	Service *projects.Service
	Store   *store.ProjectStore
}

func (p ProjectAdapter) Get(ctx context.Context, owner, id string) (api.Project, error) {
	document, err := p.Service.Load(ctx, owner, id)
	if err != nil {
		return api.Project{}, err
	}
	record, err := p.Store.Get(ctx, owner, id)
	if err != nil {
		return api.Project{}, err
	}
	return apiProject(id, document, record.UpdatedAt), nil
}

func (p ProjectAdapter) Save(ctx context.Context, owner, id string, input api.ProjectInput, duration int64) (api.Project, error) {
	document, err := p.Service.Save(ctx, owner, id, projectDocument(input), duration)
	if err != nil {
		return api.Project{}, err
	}
	record, err := p.Store.Get(ctx, owner, id)
	if err != nil {
		return api.Project{}, err
	}
	return apiProject(id, document, record.UpdatedAt), nil
}

func projectDocument(input api.ProjectInput) projects.Document {
	segments := make([]projects.Segment, len(input.Segments))
	for i, segment := range input.Segments {
		segments[i] = projects.Segment{StartMS: segment.StartMS, EndMS: segment.EndMS, Label: segment.Label}
	}
	return projects.Document{
		MediaID: input.MediaID, Revision: input.Revision, Segments: segments,
		UIState: projects.UIState{PlayheadMS: input.UIState.PlayheadMS, Zoom: input.UIState.Zoom, Muted: input.UIState.Muted},
	}
}

func apiProject(id string, document projects.Document, updated time.Time) api.Project {
	segments := make([]api.Segment, len(document.Segments))
	for i, segment := range document.Segments {
		segments[i] = api.Segment{StartMS: segment.StartMS, EndMS: segment.EndMS, Label: segment.Label}
	}
	return api.Project{
		ID: id, UpdatedAt: updated,
		ProjectInput: api.ProjectInput{
			MediaID: document.MediaID, Revision: document.Revision, Segments: segments,
			UIState: api.UIState{PlayheadMS: document.UIState.PlayheadMS, Zoom: document.UIState.Zoom, Muted: document.UIState.Muted},
		},
	}
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

func (e *ExportAdapter) Create(ctx context.Context, owner, projectID string, project api.Project, input api.ExportInput) (api.Job, error) {
	select {
	case e.slots <- struct{}{}:
	default:
		return api.Job{}, api.ErrBusy
	}
	admitted := false
	defer func() {
		if !admitted {
			<-e.slots
		}
	}()

	id, err := newID("j_")
	if err != nil {
		return api.Job{}, err
	}
	request := exporter.Request{Mode: input.Mode, CutStrategy: input.CutStrategy, Container: input.Container}
	data, err := json.Marshal(request)
	if err != nil {
		return api.Job{}, err
	}
	record, err := e.Store.Create(ctx, store.ExportJob{
		ID: id, OwnerLogin: owner, ProjectID: projectID,
		ProjectRevision: project.Revision, RequestJSON: string(data),
	})
	if err != nil {
		return api.Job{}, err
	}
	jobCtx, cancel := context.WithCancel(context.Background())
	e.mu.Lock()
	e.cancel[id] = cancel
	e.mu.Unlock()
	admitted = true
	go e.run(jobCtx, owner, id, project)
	return apiJob(record), nil
}

func (e *ExportAdapter) run(ctx context.Context, owner, id string, project api.Project) {
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
	_, _ = e.Coordinator.Execute(ctx, owner, id, file, projectDocument(project.ProjectInput))
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

func (j JobAdapter) Get(ctx context.Context, owner, id string) (api.Job, error) {
	if job, ok := j.Refresh.get(owner, id); ok {
		return job, nil
	}
	record, err := j.Exports.Store.Get(ctx, owner, id)
	if err != nil {
		return api.Job{}, err
	}
	return apiJob(record), nil
}

func (j JobAdapter) Cancel(_ context.Context, owner, id string) error {
	if _, ok := j.Refresh.get(owner, id); ok {
		return nil
	}
	return j.Exports.cancelJob(owner, id)
}

func apiJob(record store.ExportJob) api.Job {
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
	return api.Job{
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
