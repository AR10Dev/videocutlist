// Package application contains use cases and consumer-owned ports.
package application

import (
	"context"
	"errors"
	"io"
	"time"

	"videocutlist/domain"
)

var ErrBusy = errors.New("service is busy")
var ErrNoAudio = errors.New("no_audio")

type Media struct {
	ID         string         `json:"id"`
	Name       string         `json:"name"`
	DurationMS int64          `json:"durationMs"`
	SizeBytes  int64          `json:"sizeBytes"`
	Container  string         `json:"container"`
	Streams    map[string]any `json:"streams"`
	ETag       string         `json:"etag"`
}
type MediaPage struct {
	Items      []Media `json:"items"`
	NextCursor *string `json:"nextCursor"`
}
type FolderNode struct {
	ID    string `json:"id"`
	Label string `json:"label"`
}
type FolderPage struct {
	Folders    []FolderNode `json:"folders"`
	Items      []Media      `json:"items"`
	NextCursor *string      `json:"nextCursor"`
}

type LibraryState string

const (
	LibraryUnconfigured   LibraryState = "unconfigured"
	LibraryScanning       LibraryState = "scanning"
	LibraryReadyEmpty     LibraryState = "ready_empty"
	LibraryReadyWithMedia LibraryState = "ready_with_media"
	LibraryFailed         LibraryState = "failed"
)

type RootLibraryStatus struct {
	State     LibraryState `json:"state"`
	ErrorCode string       `json:"errorCode,omitempty"`
}

type LibraryStatus struct {
	State   LibraryState                 `json:"state"`
	Message string                       `json:"message"`
	Roots   map[string]RootLibraryStatus `json:"roots,omitempty"`
}

type ImportJob struct {
	ID               string   `json:"id"`
	State            string   `json:"state"`
	Progress         float64  `json:"progress"`
	Indexed          int      `json:"indexed"`
	ErrorCode        string   `json:"errorCode,omitempty"`
	ValidationErrors []string `json:"validationErrors,omitempty"`
}

type MediaImportService interface {
	StartImport(context.Context, domain.Principal) (ImportJob, error)
	ImportStatus(context.Context, domain.Principal, string) (ImportJob, error)
	CancelImport(context.Context, domain.Principal, string) error
}
type Segment = domain.Segment
type UIState = domain.UIState
type ProjectInput = domain.Document
type Project struct {
	domain.Document
	ID        string    `json:"id"`
	Revision  int64     `json:"revision"`
	UpdatedAt time.Time `json:"updatedAt"`
}
type ExportInput struct {
	Mode             string   `json:"mode"`
	Selection        string   `json:"selection"`
	StreamIndexes    []int    `json:"streamIndexes,omitempty"`
	CutStrategy      string   `json:"cutStrategy"`
	Container        string   `json:"container"`
	DestinationID    string   `json:"destinationId,omitempty"`
	FilenameTemplate string   `json:"filenameTemplate,omitempty"`
	ItemIDs          []string `json:"itemIds,omitempty"`
}
type Job struct {
	ID              string               `json:"id"`
	Type            string               `json:"type"`
	State           string               `json:"state"`
	Progress        float64              `json:"progress"`
	Result          *JobResult           `json:"result,omitempty"`
	Warnings        []string             `json:"warnings,omitempty"`
	WarningDetails  []ExportFinding      `json:"warningDetails,omitempty"`
	Strategy        string               `json:"strategy,omitempty"`
	AppliedStrategy string               `json:"appliedStrategy,omitempty"`
	Mode            string               `json:"mode,omitempty"`
	Selection       string               `json:"selection,omitempty"`
	SelectedStreams []int                `json:"selectedStreams,omitempty"`
	Verified        bool                 `json:"verified,omitempty"`
	ErrorCode       *string              `json:"errorCode,omitempty"`
	CreatedAt       time.Time            `json:"createdAt"`
	UpdatedAt       time.Time            `json:"updatedAt"`
	MediaID         string               `json:"mediaId,omitempty"`
	ProjectID       string               `json:"projectId,omitempty"`
	ProjectRevision int64                `json:"projectRevision,omitempty"`
	Kind            domain.DetectionKind `json:"kind,omitempty"`
	Candidates      []domain.Candidate   `json:"candidates,omitempty"`
}
type AppliedStrategy struct {
	Segment    int    `json:"segment"`
	OutputName string `json:"outputName,omitempty"`
	Strategy   string `json:"strategy"`
}

type JobResult struct {
	OutputName        string            `json:"outputName,omitempty"`
	OutputNames       []string          `json:"outputNames,omitempty"`
	AppliedStrategies []AppliedStrategy `json:"appliedStrategies,omitempty"`
	SizeBytes         int64             `json:"sizeBytes"`
	RetainUntil       time.Time         `json:"retainUntil"`
	DestinationID     string            `json:"destinationId,omitempty"`
	DestinationKind   string            `json:"destinationKind,omitempty"`
}
type PreviewSpec struct {
	MediaID                                 string
	DurationMS, StartMS, WindowMS, OffsetMS int64
	Mute                                    bool
}
type PreviewResult struct {
	Reader                        io.ReadCloser
	CacheStatus                   string
	StartMS, DurationMS, OffsetMS int64
}
type AssetSpec struct {
	MediaID    string
	StartMS    int64
	DurationMS int64
	Count      int
	Width      int
	Samples    int
}
type AssetResult struct {
	Reader      io.ReadCloser
	ContentType string
	CacheStatus string
	StartMS     int64
	DurationMS  int64
	Peaks       []float64
}

type MediaService interface {
	List(context.Context, string, int) (MediaPage, error)
	Browse(context.Context, string, string, int) (FolderPage, error)
	Get(context.Context, string) (Media, error)
	RefreshMedia(context.Context) error
	Status() LibraryStatus
}
type PreviewService interface {
	Start(context.Context, domain.Principal, PreviewSpec) (PreviewResult, error)
	Cached(context.Context, PreviewSpec) (bool, error)
}
type AssetService interface {
	Thumbnails(context.Context, domain.Principal, AssetSpec) (AssetResult, error)
	Waveform(context.Context, domain.Principal, AssetSpec) (AssetResult, error)
}
type ProjectService interface {
	Create(context.Context, string, ProjectInput) (Project, error)
	Get(context.Context, string) (Project, error)
	Save(context.Context, string, ProjectInput) (Project, error)
}
type ExportService interface {
	Create(context.Context, domain.Principal, string, Project, ExportInput) (Job, error)
}
type ExportPreflightService interface {
	Preflight(context.Context, domain.Principal, string, Project, ExportInput) (ExportPreflight, error)
}
type ExportFinding struct {
	Severity    string `json:"severity"`
	Code        string `json:"code"`
	Message     string `json:"message"`
	StreamIndex *int   `json:"streamIndex,omitempty"`
}
type ExportPreflight struct {
	Allowed   bool            `json:"allowed"`
	Selection []int           `json:"selection"`
	Findings  []ExportFinding `json:"findings"`
}
type JobService interface {
	Get(context.Context, domain.Principal, string) (Job, error)
	Cancel(context.Context, domain.Principal, string) error
}
type ExportDownloadService interface {
	Download(context.Context, domain.Principal, string, int) (io.ReadCloser, string, error)
}

// NormalizePreview is the one frozen preview-window implementation used by all transports.
func NormalizePreview(mediaID string, durationMS, centerMS int64, mute bool, cfg domain.WindowConfig) (PreviewSpec, error) {
	window, err := domain.Normalize(centerMS, durationMS, cfg)
	if err != nil {
		return PreviewSpec{}, err
	}
	return PreviewSpec{MediaID: mediaID, DurationMS: durationMS, StartMS: window.StartMS, WindowMS: window.DurationMS, OffsetMS: window.OffsetMS, Mute: mute}, nil
}
