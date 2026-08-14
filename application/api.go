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
type Segment = domain.Segment
type UIState = domain.UIState
type ProjectInput = domain.Document
type Project struct {
	domain.Document
	ID        string    `json:"id"`
	UpdatedAt time.Time `json:"updatedAt"`
}
type ExportInput struct {
	Mode                  string `json:"mode"`
	CutStrategy           string `json:"cutStrategy"`
	Container             string `json:"container"`
	SmartBoundaryReencode *bool  `json:"smartBoundaryReencode,omitempty"`
}
type Job struct {
	ID        string     `json:"id"`
	Type      string     `json:"type"`
	State     string     `json:"state"`
	Progress  float64    `json:"progress"`
	Result    *JobResult `json:"result,omitempty"`
	Warnings  []string   `json:"warnings,omitempty"`
	ErrorCode *string    `json:"errorCode,omitempty"`
	CreatedAt time.Time  `json:"createdAt"`
	UpdatedAt time.Time  `json:"updatedAt"`
}
type JobResult struct {
	OutputName  string    `json:"outputName"`
	SizeBytes   int64     `json:"sizeBytes"`
	RetainUntil time.Time `json:"retainUntil"`
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

type MediaService interface {
	List(context.Context, string, int) (MediaPage, error)
	Get(context.Context, string) (Media, error)
	RefreshMedia(context.Context) error
}
type PreviewService interface {
	Start(context.Context, domain.Principal, PreviewSpec) (PreviewResult, error)
	Cached(context.Context, PreviewSpec) (bool, error)
}
type ProjectService interface {
	Get(context.Context, domain.Principal, string) (Project, error)
	Save(context.Context, domain.Principal, string, ProjectInput, int64) (Project, error)
}
type ExportService interface {
	Create(context.Context, domain.Principal, string, Project, ExportInput) (Job, error)
}
type JobService interface {
	Get(context.Context, domain.Principal, string) (Job, error)
	Cancel(context.Context, domain.Principal, string) error
}

// NormalizePreview is the one frozen preview-window implementation used by all transports.
func NormalizePreview(mediaID string, durationMS, centerMS int64, mute bool, cfg domain.WindowConfig) (PreviewSpec, error) {
	window, err := domain.Normalize(centerMS, durationMS, cfg)
	if err != nil {
		return PreviewSpec{}, err
	}
	return PreviewSpec{MediaID: mediaID, DurationMS: durationMS, StartMS: window.StartMS, WindowMS: window.DurationMS, OffsetMS: window.OffsetMS, Mute: mute}, nil
}
