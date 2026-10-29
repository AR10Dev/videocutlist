// Package media owns media library contracts.
package media

import (
	"context"

	"videocutlist/internal/library/media/index"
	"videocutlist/internal/preview"
)

type Media struct {
	ID         string         `json:"id"`
	RootID     string         `json:"-"`
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
	ID               string                       `json:"id"`
	State            string                       `json:"state"`
	Progress         float64                      `json:"progress"`
	Indexed          int                          `json:"indexed"`
	RootResults      map[string]RootLibraryStatus `json:"rootResults,omitempty"`
	ErrorCode        string                       `json:"errorCode,omitempty"`
	ValidationErrors []string                     `json:"validationErrors,omitempty"`
}

type MediaImportService interface {
	StartImport(context.Context, string) (ImportJob, error)
	ImportStatus(context.Context, string) (ImportJob, error)
	CancelImport(context.Context, string) error
}

type MediaService interface {
	List(context.Context, string, int) (MediaPage, error)
	Browse(context.Context, string, string, int) (FolderPage, error)
	Get(context.Context, string) (Media, error)
	RefreshMedia(context.Context) error
	Status() LibraryStatus
}

type RootStatusCatalog interface {
	RootStatuses() map[string]index.RootStatus
}

type MediaCatalog interface {
	List(context.Context, string, int) (MediaPage, error)
	Browse(context.Context, string, string, int) (FolderPage, error)
	Get(context.Context, string) (Media, error)
	Refresh(context.Context) error
	Preview(context.Context, preview.PreviewSpec) (preview.TranscodeSpec, error)
}
