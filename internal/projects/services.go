package projects

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"slices"
	"sync"
	"time"

	"videocutlist/internal/db"
	jobqueue "videocutlist/internal/jobs"
	"videocutlist/internal/library/media/index"
	"videocutlist/internal/projects/model"
)

var ErrJobState = jobqueue.ErrJobState

type RootStatusCatalog interface {
	RootStatuses() map[string]index.RootStatus
}

type MediaCatalog interface {
	List(context.Context, string, int) (MediaPage, error)
	Browse(context.Context, string, string, int) (FolderPage, error)
	Get(context.Context, string) (Media, error)
	Refresh(context.Context) error
	Preview(context.Context, PreviewSpec) (model.PreviewSpec, error)
}

type ProjectRecord struct {
	Document  model.Document
	Revision  int64
	UpdatedAt time.Time
}
type ProjectRepository interface {
	Get(context.Context, string) (ProjectRecord, error)
	Save(context.Context, string, int64, model.Document) (ProjectRecord, error)
}
type ProjectListRepository interface {
	List(context.Context, string, int) ([]store.ProjectSummary, *string, error)
}

type ProjectItemError struct {
	ItemID string
	Code   string
}

func (e *ProjectItemError) Error() string { return "project item " + e.ItemID + ": " + e.Code }

type MediaUseCase struct {
	Catalog    MediaCatalog
	Configured bool
	// Scheduler and UnifiedJobs are the durable production path for refreshes.
	Scheduler   *jobqueue.Scheduler
	UnifiedJobs *jobqueue.JobsStore
	status      LibraryStatus
	mu          sync.RWMutex
	refreshID   uint64
}

func (m *MediaUseCase) StartImport(ctx context.Context) (ImportJob, error) {
	if !m.Configured {
		return ImportJob{}, errors.New("media library is not configured")
	}
	if m.Scheduler == nil || m.UnifiedJobs == nil {
		return ImportJob{}, errors.New("unified job scheduler is not configured")
	}
	id, err := newID("j_")
	if err != nil {
		return ImportJob{}, err
	}
	batchID, err := newID("b_")
	if err != nil {
		return ImportJob{}, err
	}
	jobs, err := m.Scheduler.Submit(ctx, []jobqueue.Job{{ID: id, BatchID: batchID, Kind: jobqueue.JobScan, RequestJSON: `{}`}})
	if err != nil {
		return ImportJob{}, err
	}
	return importJobResult(jobs[0]), nil
}

func (m *MediaUseCase) ImportStatus(ctx context.Context, id string) (ImportJob, error) {
	if m.UnifiedJobs == nil {
		return ImportJob{}, jobqueue.ErrJobNotFound
	}
	job, err := m.UnifiedJobs.Get(ctx, id)
	if err != nil || job.Kind != jobqueue.JobScan {
		return ImportJob{}, jobqueue.ErrJobNotFound
	}
	return importJobResult(job), nil
}

func (m *MediaUseCase) CancelImport(ctx context.Context, id string) error {
	if m.UnifiedJobs == nil || m.Scheduler == nil {
		return jobqueue.ErrJobNotFound
	}
	job, err := m.UnifiedJobs.Get(ctx, id)
	if err != nil || job.Kind != jobqueue.JobScan {
		return jobqueue.ErrJobNotFound
	}
	_, err = m.Scheduler.Cancel(ctx, id)
	return err
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
	status := m.status
	m.mu.RUnlock()
	if status.State == "" {
		status = libraryStatus(LibraryScanning)
	}
	if catalog, ok := m.Catalog.(RootStatusCatalog); ok {
		status.Roots = make(map[string]RootLibraryStatus)
		for alias, root := range catalog.RootStatuses() {
			status.Roots[alias] = RootLibraryStatus{State: LibraryState(root.State), ErrorCode: root.ErrorCode}
		}
	}
	return status
}
func (m *MediaUseCase) setStatusForRefresh(refreshID uint64, state LibraryState) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.refreshID == refreshID {
		m.status = libraryStatus(state)
	}
}

var safeRootAlias = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`)

func safeRootResults(raw string) map[string]RootLibraryStatus {
	var stored map[string]RootLibraryStatus
	if json.Unmarshal([]byte(raw), &stored) != nil {
		return nil
	}
	result := make(map[string]RootLibraryStatus, len(stored))
	for alias, status := range stored {
		if !safeRootAlias.MatchString(alias) || !validRootState(status.State) {
			continue
		}
		if status.ErrorCode != "" && !validRootError(status.ErrorCode) {
			continue
		}
		result[alias] = status
	}
	if len(result) == 0 {
		return nil
	}
	return result
}

func validRootState(state LibraryState) bool {
	switch state {
	case LibraryScanning, LibraryReadyEmpty, LibraryReadyWithMedia, LibraryFailed:
		return true
	default:
		return false
	}
}
func validRootError(code string) bool {
	switch code {
	case "scan_limit", "cancelled", "scan_failed":
		return true
	default:
		return false
	}
}
func validScanJobError(code string) bool {
	return validRootError(code) || code == "job_failed" || code == "interrupted_by_restart"
}

func importJobResult(job jobqueue.Job) ImportJob {
	out := ImportJob{ID: job.ID, State: string(job.State), Progress: 0}
	if job.State == jobqueue.JobSucceeded {
		out.Progress = 1
	}
	if job.ErrorCode.Valid && validScanJobError(job.ErrorCode.String) {
		out.ErrorCode = job.ErrorCode.String
	}
	if job.ResultJSON.Valid {
		out.RootResults = safeRootResults(job.ResultJSON.String)
	}
	return out
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

func (p PreviewUseCase) Start(ctx context.Context, request PreviewSpec) (PreviewResult, error) {
	spec, err := p.Catalog.Preview(ctx, request)
	if err != nil {
		return PreviewResult{}, err
	}
	reader, result, err := p.Manager.Preview(ctx, spec)
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

func (m *PreviewManager) Cached(ctx context.Context, spec model.PreviewSpec) (bool, error) {
	reader, err := m.cache.Open(ctx, model.PreviewKey(spec), m.validator)
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

func (p ProjectUseCase) List(ctx context.Context, cursor string, limit int) (ProjectPage, error) {
	repository, ok := p.Repository.(ProjectListRepository)
	if !ok {
		return ProjectPage{}, errors.New("project listing is not configured")
	}
	items, next, err := repository.List(ctx, cursor, limit)
	if err != nil {
		return ProjectPage{}, err
	}
	page := ProjectPage{NextCursor: next}
	page.Items = make([]ProjectSummary, len(items))
	for i, item := range items {
		page.Items[i] = ProjectSummary{ID: item.ID, Name: item.Name, Revision: item.Revision, UpdatedAt: item.UpdatedAt}
	}
	return page, nil
}

func (p ProjectUseCase) Get(ctx context.Context, id string) (Project, error) {
	record, err := p.Repository.Get(ctx, id)
	if err != nil {
		return Project{}, err
	}
	return Project{ID: id, Document: record.Document, Revision: record.Revision, UpdatedAt: record.UpdatedAt}, nil
}

func (p ProjectUseCase) Save(ctx context.Context, id string, input ProjectInput) (Project, error) {
	return p.save(ctx, id, input)
}

func (p ProjectUseCase) save(ctx context.Context, id string, input ProjectInput) (Project, error) {
	if p.Media == nil {
		return Project{}, errors.New("project media catalog is required")
	}
	if err := model.ValidateProject(input.Document); err != nil {
		return Project{}, err
	}
	for _, item := range input.Document.Items {
		media, err := p.Media.Get(ctx, item.MediaID)
		if err != nil {
			return Project{}, &ProjectItemError{ItemID: item.ID, Code: "media_unavailable"}
		}
		if err := model.ValidateProjectItem(item, media.DurationMS); err != nil {
			return Project{}, &ProjectItemError{ItemID: item.ID, Code: "invalid"}
		}
	}
	record, err := p.Repository.Save(ctx, id, input.Revision, input.Document)
	if err != nil {
		return Project{}, err
	}
	return Project{ID: id, Document: record.Document, Revision: record.Revision, UpdatedAt: record.UpdatedAt}, nil
}

func runtimeSettings(state *store.RuntimeSettingsState) *store.RuntimeSettings {
	if state == nil {
		return nil
	}
	settings := state.Snapshot()
	return &settings
}

type UnifiedJobs interface {
	Get(context.Context, string) (jobqueue.Job, error)
	Cancel(context.Context, string) (jobqueue.Job, error)
}

type JobUseCase struct{ Jobs UnifiedJobs }

func (j JobUseCase) Get(ctx context.Context, id string) (Job, error) {
	if j.Jobs == nil {
		return Job{}, jobqueue.ErrJobNotFound
	}
	value, err := j.Jobs.Get(ctx, id)
	if err != nil {
		return Job{}, err
	}
	return unifiedJobResult(value), nil
}
func (j JobUseCase) Cancel(ctx context.Context, id string) error {
	if j.Jobs == nil {
		return jobqueue.ErrJobNotFound
	}
	_, err := j.Jobs.Cancel(ctx, id)
	if errors.Is(err, jobqueue.ErrJobState) {
		return nil
	}
	return err
}

func stringPointer(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

func unifiedJobResult(value jobqueue.Job) Job {
	var job Job
	switch value.Kind {
	case jobqueue.JobExport:
		job = jobResult(value)
		var snapshot ExportSnapshot
		if json.Unmarshal([]byte(value.RequestJSON), &snapshot) == nil {
			job.ProjectRevision = snapshot.ProjectRevision
			job.MediaID = snapshot.Source.MediaID
			job.MediaLabel = snapshot.MediaLabel
		}
	case jobqueue.JobDetect:
		result, err := storeDetectionJobResult(value)
		if err == nil {
			job = detectionJobAsJob(result)
		}
	case jobqueue.JobScan:
		result := importJobResult(value)
		job = Job{ID: result.ID, Type: string(value.Kind), State: result.State, Progress: result.Progress, RootResults: result.RootResults, ErrorCode: stringPointer(result.ErrorCode), CreatedAt: value.CreatedAt, UpdatedAt: value.UpdatedAt}
	}
	if job.ID == "" {
		job = Job{ID: value.ID, Type: string(value.Kind), State: string(value.State), CreatedAt: value.CreatedAt, UpdatedAt: value.UpdatedAt}
		if value.State == jobqueue.JobRunning {
			job.Progress = .5
		} else if value.State == jobqueue.JobSucceeded || value.State == jobqueue.JobFailed || value.State == jobqueue.JobCancelled {
			job.Progress = 1
		}
		if value.ErrorCode.Valid {
			code := value.ErrorCode.String
			job.ErrorCode = &code
		}
	}
	job.BatchID = value.BatchID
	job.ProjectItemID = value.ProjectItemID
	return job
}

func storeDetectionJobResult(value jobqueue.Job) (DetectionJob, error) {
	var request struct {
		MediaID         string `json:"mediaId"`
		ProjectRevision int64  `json:"projectRevision"`
		Kind            string `json:"kind"`
	}
	if err := json.Unmarshal([]byte(value.RequestJSON), &request); err != nil {
		return DetectionJob{}, err
	}
	result := DetectionJob{ID: value.ID, Type: string(value.Kind), State: string(value.State), MediaID: request.MediaID, ProjectID: value.ProjectID, ProjectRevision: request.ProjectRevision, Kind: model.DetectionKind(request.Kind)}
	if value.ResultJSON.Valid {
		_ = json.Unmarshal([]byte(value.ResultJSON.String), &result.Candidates)
	}
	if value.ErrorCode.Valid {
		code := value.ErrorCode.String
		result.ErrorCode = &code
	}
	return result, nil
}

func detectionJobAsJob(value DetectionJob) Job {
	return Job{ID: value.ID, Type: value.Type, State: value.State, MediaID: value.MediaID, ProjectID: value.ProjectID, ProjectRevision: value.ProjectRevision, Kind: value.Kind, Candidates: value.Candidates, ErrorCode: value.ErrorCode}
}

func jobResult(record jobqueue.Job) Job {
	progress := 0.0
	if record.State == jobqueue.JobRunning {
		progress = .5
	}
	if record.State == jobqueue.JobSucceeded || record.State == jobqueue.JobFailed || record.State == jobqueue.JobCancelled {
		progress = 1
	}
	job := Job{ID: record.ID, Type: "export", State: string(record.State), Progress: progress, CreatedAt: record.CreatedAt, UpdatedAt: record.UpdatedAt}
	var request ExportInput
	if json.Unmarshal([]byte(record.RequestJSON), &request) == nil {
		job.Strategy, job.Mode, job.Selection, job.SelectedStreams = request.CutStrategy, request.Mode, request.Selection, slices.Clone(request.StreamIndexes)
	}
	if record.State == jobqueue.JobFailed && record.ErrorCode.Valid {
		value := record.ErrorCode.String
		job.ErrorCode = &value
	}
	if record.State == jobqueue.JobSucceeded && record.ResultJSON.Valid {
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
