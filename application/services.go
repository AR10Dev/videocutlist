package application

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync"
	"time"

	"videocutlist/domain"
)

var ErrJobState = errors.New("invalid export job transition")

type MediaCatalog interface {
	List(context.Context, string, int) (MediaPage, error)
	Get(context.Context, string) (Media, error)
	Refresh(context.Context) error
	Preview(context.Context, PreviewSpec) (domain.PreviewSpec, error)
}

type ProjectRecord struct {
	Document  domain.Document
	UpdatedAt time.Time
}
type ProjectRepository interface {
	Get(context.Context, string, string) (ProjectRecord, error)
	Save(context.Context, string, string, domain.Document) (ProjectRecord, error)
}

type ExportJob struct {
	ID, Owner, ProjectID, State, RequestJSON string
	ProjectRevision                          int64
	ResultJSON                               *string
	CreatedAt, UpdatedAt                     time.Time
}
type ExportJobs interface {
	Create(context.Context, ExportJob) (ExportJob, error)
	Get(context.Context, string, string) (ExportJob, error)
	Cancel(context.Context, string, string) (ExportJob, error)
}
type ExportExecutor interface {
	Execute(context.Context, string, string, domain.Document) error
}

type RefreshJobs struct {
	mu   sync.Mutex
	jobs map[string]ownedJob
}
type ownedJob struct {
	owner string
	job   Job
}

func NewRefreshJobs() *RefreshJobs { return &RefreshJobs{jobs: map[string]ownedJob{}} }
func (r *RefreshJobs) Put(owner string, job Job) {
	r.mu.Lock()
	r.jobs[job.ID] = ownedJob{owner, job}
	r.mu.Unlock()
}
func (r *RefreshJobs) Get(owner, id string) (Job, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	job, ok := r.jobs[id]
	return job.job, ok && job.owner == owner
}

type MediaUseCase struct {
	Catalog    MediaCatalog
	Refresh    *RefreshJobs
	mu         sync.Mutex
	refreshing bool
	refreshed  time.Time
}

func (m *MediaUseCase) List(ctx context.Context, cursor string, limit int) (MediaPage, error) {
	return m.Catalog.List(ctx, cursor, limit)
}
func (m *MediaUseCase) Get(ctx context.Context, id string) (Media, error) {
	return m.Catalog.Get(ctx, id)
}
func (m *MediaUseCase) RefreshMedia(ctx context.Context, principal domain.Principal) (Job, error) {
	m.mu.Lock()
	if m.refreshing || !m.refreshed.IsZero() && time.Since(m.refreshed) < time.Minute {
		m.mu.Unlock()
		return Job{}, ErrBusy
	}
	m.refreshing = true
	m.mu.Unlock()
	defer func() { m.mu.Lock(); m.refreshing = false; m.refreshed = time.Now(); m.mu.Unlock() }()
	id, err := newID("j_")
	if err != nil {
		return Job{}, err
	}
	started := time.Now().UTC()
	if err := m.Catalog.Refresh(ctx); err != nil {
		return Job{}, err
	}
	job := Job{ID: id, Type: "media_refresh", State: "succeeded", Progress: 1, CreatedAt: started, UpdatedAt: time.Now().UTC()}
	m.Refresh.Put(principal.Subject, job)
	return job, nil
}

type PreviewUseCase struct {
	Catalog MediaCatalog
	Manager *PreviewManager
}

func (p PreviewUseCase) Start(ctx context.Context, principal domain.Principal, request PreviewSpec) (PreviewResult, error) {
	spec, err := p.Catalog.Preview(ctx, request)
	if err != nil {
		return PreviewResult{}, err
	}
	reader, result, err := p.Manager.Preview(ctx, principal.Subject, spec)
	if err != nil {
		return PreviewResult{}, err
	}
	return PreviewResult{Reader: reader, CacheStatus: string(result.Status), StartMS: request.StartMS, DurationMS: request.WindowMS, OffsetMS: request.OffsetMS}, nil
}
func (p PreviewUseCase) Cached(ctx context.Context, request PreviewSpec) (bool, error) {
	spec, err := p.Catalog.Preview(ctx, request)
	if err != nil {
		return false, err
	}
	return p.Manager.Cached(ctx, spec)
}

func (m *PreviewManager) Cached(ctx context.Context, spec domain.PreviewSpec) (bool, error) {
	reader, err := m.cache.Open(ctx, domain.PreviewKey(spec), m.validator)
	if errors.Is(err, ErrCacheMiss) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, reader.Close()
}

type ProjectUseCase struct{ Repository ProjectRepository }

func (p ProjectUseCase) Get(ctx context.Context, principal domain.Principal, id string) (Project, error) {
	record, err := p.Repository.Get(ctx, principal.Subject, id)
	if err != nil {
		return Project{}, err
	}
	return Project{ID: id, Document: record.Document, UpdatedAt: record.UpdatedAt}, nil
}
func (p ProjectUseCase) Save(ctx context.Context, principal domain.Principal, id string, input ProjectInput, duration int64) (Project, error) {
	if err := domain.Validate(input, duration); err != nil {
		return Project{}, err
	}
	record, err := p.Repository.Save(ctx, principal.Subject, id, input)
	if err != nil {
		return Project{}, err
	}
	return Project{ID: id, Document: record.Document, UpdatedAt: record.UpdatedAt}, nil
}

type ExportUseCase struct {
	Jobs     ExportJobs
	Executor ExportExecutor
	slots    chan struct{}
	mu       sync.Mutex
	cancel   map[string]context.CancelFunc
}

func NewExportUseCase(jobs ExportJobs, executor ExportExecutor, limit int) *ExportUseCase {
	return &ExportUseCase{Jobs: jobs, Executor: executor, slots: make(chan struct{}, limit), cancel: map[string]context.CancelFunc{}}
}
func (e *ExportUseCase) Create(ctx context.Context, principal domain.Principal, projectID string, project Project, input ExportInput) (Job, error) {
	select {
	case e.slots <- struct{}{}:
	default:
		return Job{}, ErrBusy
	}
	admitted := false
	defer func() {
		if !admitted {
			<-e.slots
		}
	}()
	id, err := newID("j_")
	if err != nil {
		return Job{}, err
	}
	data, err := json.Marshal(struct {
		Mode        string `json:"mode"`
		CutStrategy string `json:"cutStrategy"`
		Container   string `json:"container"`
	}{input.Mode, input.CutStrategy, input.Container})
	if err != nil {
		return Job{}, err
	}
	record, err := e.Jobs.Create(ctx, ExportJob{ID: id, Owner: principal.Subject, ProjectID: projectID, ProjectRevision: project.Revision, RequestJSON: string(data)})
	if err != nil {
		return Job{}, err
	}
	jobCtx, cancel := context.WithCancel(context.Background())
	e.mu.Lock()
	e.cancel[id] = cancel
	e.mu.Unlock()
	admitted = true
	go e.run(jobCtx, principal.Subject, id, project.Document)
	return jobResult(record), nil
}
func (e *ExportUseCase) run(ctx context.Context, owner, id string, document domain.Document) {
	defer func() { <-e.slots }()
	defer func() { e.mu.Lock(); delete(e.cancel, id); e.mu.Unlock() }()
	_ = e.Executor.Execute(ctx, owner, id, document)
}
func (e *ExportUseCase) Get(ctx context.Context, owner, id string) (Job, error) {
	record, err := e.Jobs.Get(ctx, owner, id)
	if err != nil {
		return Job{}, err
	}
	return jobResult(record), nil
}
func (e *ExportUseCase) Cancel(ctx context.Context, owner, id string) error {
	record, err := e.Jobs.Get(ctx, owner, id)
	if err != nil {
		return err
	}
	if record.State == "succeeded" || record.State == "failed" || record.State == "cancelled" {
		return nil
	}
	e.mu.Lock()
	cancel := e.cancel[id]
	e.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	_, err = e.Jobs.Cancel(ctx, owner, id)
	if errors.Is(err, ErrJobState) {
		return nil
	}
	return err
}

type JobUseCase struct {
	Exports *ExportUseCase
	Refresh *RefreshJobs
}

func (j JobUseCase) Get(ctx context.Context, principal domain.Principal, id string) (Job, error) {
	if job, ok := j.Refresh.Get(principal.Subject, id); ok {
		return job, nil
	}
	return j.Exports.Get(ctx, principal.Subject, id)
}
func (j JobUseCase) Cancel(ctx context.Context, principal domain.Principal, id string) error {
	if _, ok := j.Refresh.Get(principal.Subject, id); ok {
		return nil
	}
	return j.Exports.Cancel(ctx, principal.Subject, id)
}

func jobResult(record ExportJob) Job {
	progress := 0.0
	if record.State == "running" {
		progress = .5
	}
	if record.State == "succeeded" || record.State == "failed" || record.State == "cancelled" {
		progress = 1
	}
	var warnings []string
	if record.ResultJSON != nil {
		var result struct {
			Warnings []struct {
				Message string `json:"message"`
			} `json:"warnings"`
		}
		if json.Unmarshal([]byte(*record.ResultJSON), &result) == nil {
			for _, warning := range result.Warnings {
				warnings = append(warnings, warning.Message)
			}
		}
	}
	return Job{ID: record.ID, Type: "export", State: record.State, Progress: progress, Warnings: warnings, CreatedAt: record.CreatedAt, UpdatedAt: record.UpdatedAt}
}
func newID(prefix string) (string, error) {
	var value [18]byte
	if _, err := io.ReadFull(rand.Reader, value[:]); err != nil {
		return "", fmt.Errorf("generate id: %w", err)
	}
	return prefix + base64.RawURLEncoding.EncodeToString(value[:]), nil
}
