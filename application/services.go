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
	"videocutlist/infrastructure/store"
)

var ErrJobState = store.ErrJobState

type MediaCatalog interface {
	List(context.Context, string, int) (MediaPage, error)
	Browse(context.Context, string, string, int) (FolderPage, error)
	Get(context.Context, string) (Media, error)
	Refresh(context.Context) error
	Preview(context.Context, PreviewSpec) (domain.PreviewSpec, error)
}

type ProjectRecord struct {
	Document  domain.Document
	UpdatedAt time.Time
}
type ProjectRepository interface {
	Get(context.Context, string) (ProjectRecord, error)
	Save(context.Context, string, domain.Document) (ProjectRecord, error)
}

type ProjectItemError struct {
	ItemID string
	Code   string
}

func (e *ProjectItemError) Error() string { return "project item " + e.ItemID + ": " + e.Code }

type ExportJobs interface {
	Create(context.Context, store.ExportJob) (store.ExportJob, error)
	Get(context.Context, string, string) (store.ExportJob, error)
	Cancel(context.Context, string, string) (store.ExportJob, error)
}
type ExportExecutor interface {
	Execute(context.Context, string, string, domain.Document) error
	Preflight(context.Context, domain.Principal, string, Project, ExportInput) (ExportPreflight, error)
}

type MediaUseCase struct {
	Catalog    MediaCatalog
	Configured bool
	status     LibraryStatus
	mu         sync.RWMutex
	imports    map[string]*mediaImport
	refreshID  uint64
}

type mediaImport struct {
	job    ImportJob
	owner  string
	cancel context.CancelFunc
}

// mediaImportRetention bounds how long terminal jobs remain available for polling.
var mediaImportRetention = time.Minute

func (m *MediaUseCase) StartImport(ctx context.Context, principal domain.Principal) (ImportJob, error) {
	if !m.Configured {
		return ImportJob{}, errors.New("media library is not configured")
	}
	id, err := newID("j_")
	if err != nil {
		return ImportJob{}, err
	}
	jobCtx, cancel := context.WithCancel(context.Background())
	m.mu.Lock()
	if m.imports == nil {
		m.imports = make(map[string]*mediaImport)
	}
	if m.status.State == LibraryScanning {
		m.mu.Unlock()
		cancel()
		return ImportJob{}, ErrBusy
	}
	entry := &mediaImport{job: ImportJob{ID: id, State: "queued"}, owner: principal.Subject, cancel: cancel}
	m.imports[id] = entry
	m.status = libraryStatus(LibraryScanning)
	job := entry.job
	m.mu.Unlock()
	go m.runImport(jobCtx, entry)
	return job, nil
}
func (m *MediaUseCase) runImport(ctx context.Context, entry *mediaImport) {
	m.mu.Lock()
	entry.job.State = "running"
	m.mu.Unlock()
	err := m.RefreshMedia(ctx)
	m.mu.Lock()
	if errors.Is(ctx.Err(), context.Canceled) {
		entry.job.State = "cancelled"
	} else if err != nil {
		entry.job.State = "failed"
		entry.job.ErrorCode = "import_failed"
	} else {
		entry.job.State, entry.job.Progress = "succeeded", 1
	}
	// Read the retention setting while publishing the terminal state so polling
	// observes completion before a test or configuration update changes it.
	retention := mediaImportRetention
	m.mu.Unlock()
	// Keep terminal state available briefly so clients can observe it, then drop it.
	time.AfterFunc(retention, func() {
		m.mu.Lock()
		if current, ok := m.imports[entry.job.ID]; ok && current == entry && current.job.State != "running" && current.job.State != "queued" {
			delete(m.imports, entry.job.ID)
		}
		m.mu.Unlock()
	})
}
func (m *MediaUseCase) ImportStatus(_ context.Context, principal domain.Principal, id string) (ImportJob, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	entry, ok := m.imports[id]
	if !ok || entry.owner != principal.Subject {
		return ImportJob{}, errors.New("import job not found")
	}
	return entry.job, nil
}
func (m *MediaUseCase) CancelImport(_ context.Context, principal domain.Principal, id string) error {
	m.mu.RLock()
	entry, ok := m.imports[id]
	m.mu.RUnlock()
	if !ok || entry.owner != principal.Subject {
		return errors.New("import job not found")
	}
	entry.cancel()
	return nil
}

func (m *MediaUseCase) List(ctx context.Context, cursor string, limit int) (MediaPage, error) {
	return m.Catalog.List(ctx, cursor, limit)
}
func (m *MediaUseCase) Browse(ctx context.Context, folderID, cursor string, limit int) (FolderPage, error) {
	return m.Catalog.Browse(ctx, folderID, cursor, limit)
}
func (m *MediaUseCase) Get(ctx context.Context, id string) (Media, error) {
	return m.Catalog.Get(ctx, id)
}
func (m *MediaUseCase) RefreshMedia(ctx context.Context) error {
	if !m.Configured {
		return nil
	}
	m.mu.Lock()
	previous := m.status
	m.refreshID++
	refreshID := m.refreshID
	m.status = libraryStatus(LibraryScanning)
	m.mu.Unlock()
	if err := m.Catalog.Refresh(ctx); err != nil {
		if errors.Is(ctx.Err(), context.Canceled) {
			m.restoreAfterCancellation(previous, refreshID)
		} else {
			m.setStatusForRefresh(refreshID, LibraryFailed)
		}
		return err
	}
	page, err := m.Catalog.List(ctx, "", 1)
	if err != nil {
		if errors.Is(ctx.Err(), context.Canceled) {
			m.restoreAfterCancellation(previous, refreshID)
		} else {
			m.setStatusForRefresh(refreshID, LibraryFailed)
		}
		return err
	}
	if len(page.Items) == 0 {
		m.setStatusForRefresh(refreshID, LibraryReadyEmpty)
	} else {
		m.setStatusForRefresh(refreshID, LibraryReadyWithMedia)
	}
	return nil
}

const mediaStatusRecoveryTimeout = time.Second

func (m *MediaUseCase) restoreAfterCancellation(previous LibraryStatus, refreshID uint64) {
	if previous.State == LibraryReadyEmpty || previous.State == LibraryReadyWithMedia {
		m.setStatusForRefresh(refreshID, previous.State)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), mediaStatusRecoveryTimeout)
	defer cancel()
	page, err := m.Catalog.List(ctx, "", 1)
	if err == nil {
		if len(page.Items) == 0 {
			m.setStatusForRefresh(refreshID, LibraryReadyEmpty)
		} else {
			m.setStatusForRefresh(refreshID, LibraryReadyWithMedia)
		}
		return
	}
	if previous.State != "" && previous.State != LibraryScanning {
		m.setStatusForRefresh(refreshID, previous.State)
	} else {
		m.setStatusForRefresh(refreshID, LibraryReadyEmpty)
	}
}
func (m *MediaUseCase) Status() LibraryStatus {
	if !m.Configured {
		return libraryStatus(LibraryUnconfigured)
	}
	m.mu.RLock()
	defer m.mu.RUnlock()
	if m.status.State == "" {
		return libraryStatus(LibraryScanning)
	}
	return m.status
}
func (m *MediaUseCase) setStatusForRefresh(refreshID uint64, state LibraryState) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.refreshID == refreshID {
		m.status = libraryStatus(state)
	}
}
func libraryStatus(state LibraryState) LibraryStatus {
	messages := map[LibraryState]string{
		LibraryUnconfigured:   "No media library is configured.",
		LibraryScanning:       "Scanning media library.",
		LibraryReadyEmpty:     "No supported media was found.",
		LibraryReadyWithMedia: "Media library is ready.",
		LibraryFailed:         "Media library scan failed. Try refreshing it.",
	}
	return LibraryStatus{State: state, Message: messages[state]}
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

type ProjectUseCase struct {
	Repository ProjectRepository
	Media      MediaCatalog
}

func (p ProjectUseCase) Create(ctx context.Context, id string, input ProjectInput) (Project, error) {
	if input.Revision != 0 {
		return Project{}, store.ErrRevisionConflict
	}
	return p.save(ctx, id, input)
}

func (p ProjectUseCase) Get(ctx context.Context, id string) (Project, error) {
	record, err := p.Repository.Get(ctx, id)
	if err != nil {
		return Project{}, err
	}
	return Project{ID: id, Document: record.Document, Revision: record.Document.Revision, UpdatedAt: record.UpdatedAt}, nil
}

func (p ProjectUseCase) Save(ctx context.Context, id string, input ProjectInput) (Project, error) {
	return p.save(ctx, id, input)
}

func (p ProjectUseCase) save(ctx context.Context, id string, input ProjectInput) (Project, error) {
	if p.Media == nil {
		return Project{}, errors.New("project media catalog is required")
	}
	if err := domain.ValidateProject(input); err != nil {
		return Project{}, err
	}
	for _, item := range input.Items {
		media, err := p.Media.Get(ctx, item.MediaID)
		if err != nil {
			return Project{}, &ProjectItemError{ItemID: item.ID, Code: "media_unavailable"}
		}
		if err := domain.ValidateProjectItem(item, media.DurationMS); err != nil {
			return Project{}, &ProjectItemError{ItemID: item.ID, Code: "invalid"}
		}
	}
	record, err := p.Repository.Save(ctx, id, input)
	if err != nil {
		return Project{}, err
	}
	return Project{ID: id, Document: record.Document, Revision: record.Document.Revision, UpdatedAt: record.UpdatedAt}, nil
}

type ExportUseCase struct {
	Jobs     ExportJobs
	Executor ExportExecutor
	Settings *store.RuntimeSettingsState
	slots    chan struct{}
	limit    func() int
	active   int
	mu       sync.Mutex
	cancel   map[string]context.CancelFunc
}

func NewExportUseCase(jobs ExportJobs, executor ExportExecutor, limit int) *ExportUseCase {
	return &ExportUseCase{Jobs: jobs, Executor: executor, slots: make(chan struct{}, limit), cancel: map[string]context.CancelFunc{}}
}

func (e *ExportUseCase) SetLimitProvider(provider func() int) { e.limit = provider }
func (e *ExportUseCase) Create(ctx context.Context, principal domain.Principal, projectID string, project Project, input ExportInput) (Job, error) {
	preflight, err := e.Executor.Preflight(ctx, principal, projectID, project, input)
	if err != nil {
		return Job{}, err
	}
	if !preflight.Allowed {
		return Job{}, errors.New("export preflight blocked")
	}
	e.mu.Lock()
	currentLimit := cap(e.slots)
	e.mu.Unlock()
	if e.limit != nil {
		currentLimit = e.limit()
	}
	e.mu.Lock()
	if e.active >= currentLimit {
		e.mu.Unlock()
		return Job{}, ErrBusy
	}
	e.active++
	e.mu.Unlock()
	admitted := false
	defer func() {
		if !admitted {
			e.mu.Lock()
			e.active--
			e.mu.Unlock()
		}
	}()
	id, err := newID("j_")
	if err != nil {
		return Job{}, err
	}
	data, err := json.Marshal(struct {
		Mode             string                 `json:"mode"`
		Selection        string                 `json:"selection"`
		StreamIndexes    []int                  `json:"streamIndexes,omitempty"`
		CutStrategy      string                 `json:"cutStrategy"`
		Container        string                 `json:"container"`
		DestinationID    string                 `json:"destinationId,omitempty"`
		FilenameTemplate string                 `json:"filenameTemplate,omitempty"`
		Settings         *store.RuntimeSettings `json:"runtimeSettings,omitempty"`
	}{input.Mode, input.Selection, input.StreamIndexes, input.CutStrategy, input.Container, input.DestinationID, input.FilenameTemplate, runtimeSettings(e.Settings)})
	if err != nil {
		return Job{}, err
	}
	record, err := e.Jobs.Create(ctx, store.ExportJob{ID: id, OwnerLogin: principal.Subject, ProjectID: projectID, ProjectRevision: project.Revision, RequestJSON: string(data)})
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
func runtimeSettings(state *store.RuntimeSettingsState) *store.RuntimeSettings {
	if state == nil {
		return nil
	}
	settings := state.Snapshot()
	return &settings
}

func (e *ExportUseCase) run(ctx context.Context, owner, id string, document domain.Document) {
	defer func() { e.mu.Lock(); e.active--; e.mu.Unlock() }()
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
	if record.State == store.JobSucceeded || record.State == store.JobFailed || record.State == store.JobCancelled {
		return nil
	}
	e.mu.Lock()
	cancel := e.cancel[id]
	e.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	_, err = e.Jobs.Cancel(ctx, owner, id)
	if errors.Is(err, store.ErrJobState) {
		return nil
	}
	return err
}

type JobUseCase struct {
	Exports    *ExportUseCase
	Detections *DetectionUseCase
}

func (j JobUseCase) Get(ctx context.Context, principal domain.Principal, id string) (Job, error) {
	if j.Exports != nil {
		if value, err := j.Exports.Get(ctx, principal.Subject, id); err == nil {
			return value, nil
		}
	}
	if j.Detections != nil {
		value, err := j.Detections.Get(ctx, principal, id)
		if err != nil {
			return Job{}, err
		}
		return detectionJobAsJob(value), nil
	}
	return Job{}, store.ErrJobNotFound
}
func (j JobUseCase) Cancel(ctx context.Context, principal domain.Principal, id string) error {
	if j.Exports != nil {
		if err := j.Exports.Cancel(ctx, principal.Subject, id); err == nil {
			return nil
		}
	}
	if j.Detections != nil {
		return j.Detections.Cancel(ctx, principal, id)
	}
	return store.ErrJobNotFound
}

func detectionJobAsJob(value DetectionJob) Job {
	job := Job{ID: value.ID, Type: value.Type, State: value.State}
	if value.ErrorCode != nil {
		job.ErrorCode = value.ErrorCode
	}
	return job
}

func jobResult(record store.ExportJob) Job {
	progress := 0.0
	if record.State == store.JobRunning {
		progress = .5
	}
	if record.State == store.JobSucceeded || record.State == store.JobFailed || record.State == store.JobCancelled {
		progress = 1
	}
	job := Job{ID: record.ID, Type: "export", State: string(record.State), Progress: progress, CreatedAt: record.CreatedAt, UpdatedAt: record.UpdatedAt}
	var request ExportInput
	if json.Unmarshal([]byte(record.RequestJSON), &request) == nil {
		job.Strategy, job.Mode, job.Selection, job.SelectedStreams = request.CutStrategy, request.Mode, request.Selection, append([]int(nil), request.StreamIndexes...)
	}
	if record.State == store.JobFailed && record.ErrorCode.Valid {
		value := record.ErrorCode.String
		job.ErrorCode = &value
	}
	if record.State == store.JobSucceeded && record.ResultJSON.Valid {
		var result struct {
			OutputName        string            `json:"outputName"`
			OutputNames       []string          `json:"outputNames"`
			SizeBytes         int64             `json:"sizeBytes"`
			RetainUntil       time.Time         `json:"retainUntil"`
			DestinationID     string            `json:"destinationId"`
			DestinationKind   string            `json:"destinationKind"`
			AppliedStrategy   string            `json:"appliedStrategy"`
			AppliedStrategies []AppliedStrategy `json:"appliedStrategies"`
			Warnings          []struct {
				Code    string `json:"code"`
				Message string `json:"message"`
			} `json:"warnings"`
			Verified bool `json:"verified"`
		}
		if json.Unmarshal([]byte(record.ResultJSON.String), &result) == nil && safeOutputNames(result.OutputName, result.OutputNames) && safeAppliedStrategies(result.AppliedStrategies) && result.SizeBytes >= 0 && !result.RetainUntil.IsZero() {
			job.Result = &JobResult{OutputName: result.OutputName, OutputNames: result.OutputNames, AppliedStrategies: result.AppliedStrategies, SizeBytes: result.SizeBytes, RetainUntil: result.RetainUntil, DestinationID: result.DestinationID, DestinationKind: result.DestinationKind}
			job.AppliedStrategy = result.AppliedStrategy
			job.Verified = result.Verified
			for _, warning := range result.Warnings {
				if len(job.Warnings) == 10 {
					break
				}
				if len(warning.Message) > 500 {
					warning.Message = warning.Message[:500]
				}
				job.Warnings = append(job.Warnings, warning.Message)
				job.WarningDetails = append(job.WarningDetails, ExportFinding{Severity: "warn", Code: warning.Code, Message: warning.Message})
			}
		}
	}
	return job
}

func safeOutputNames(name string, names []string) bool {
	if name != "" {
		return len(names) == 0 && safeOutputName(name)
	}
	if len(names) == 0 || len(names) > 100 {
		return false
	}
	for _, output := range names {
		if !safeOutputName(output) {
			return false
		}
	}
	return true
}

func safeOutputName(name string) bool {
	if name == "" || name == "." || name == ".." || len(name) > 255 {
		return false
	}
	for _, r := range name {
		if !((r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '.' || r == '-' || r == '_') {
			return false
		}
	}
	return true
}

func safeAppliedStrategies(strategies []AppliedStrategy) bool {
	for _, strategy := range strategies {
		if strategy.Segment < 1 || (strategy.OutputName != "" && !safeOutputName(strategy.OutputName)) || (strategy.Strategy != "stream_copy" && strategy.Strategy != "stream_copy_preferred" && strategy.Strategy != "precise_reencode" && strategy.Strategy != "hybrid_smart_cut") {
			return false
		}
	}
	return true
}

func newID(prefix string) (string, error) {
	var value [18]byte
	if _, err := io.ReadFull(rand.Reader, value[:]); err != nil {
		return "", fmt.Errorf("generate id: %w", err)
	}
	return prefix + base64.RawURLEncoding.EncodeToString(value[:]), nil
}
