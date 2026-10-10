// Package projects contains project and job use cases plus their consumer-owned ports.
package projects

import (
	"context"
	"errors"
	"time"

	exporter "videocutlist/internal/export"
	"videocutlist/internal/jobs/view"
	"videocutlist/internal/projects/model"
)

var ErrBusy = errors.New("service is busy")

type Segment = model.Segment
type UIState = model.UIState
type ProjectInput struct {
	Revision int64
	model.Document
}
type Project struct {
	model.Document
	ID        string    `json:"id"`
	Revision  int64     `json:"revision"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// PreparedProject contains a validated new project and its canonical storage encoding.
type PreparedProject struct {
	Project      Project
	DocumentJSON string
}
type ProjectSummary struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Revision  int64     `json:"revision"`
	UpdatedAt time.Time `json:"updatedAt"`
}
type ProjectPage struct {
	Items      []ProjectSummary `json:"items"`
	NextCursor *string          `json:"nextCursor"`
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

type Batch struct {
	BatchID         string     `json:"batchId"`
	ProjectID       string     `json:"projectId,omitempty"`
	ProjectRevision int64      `json:"projectRevision,omitempty"`
	State           string     `json:"state"`
	Progress        float64    `json:"progress"`
	Jobs            []view.Job `json:"jobs"`
}

type BatchPage struct {
	Items      []Batch `json:"items"`
	NextCursor *string `json:"nextCursor"`
}

type ProjectService interface {
	Create(context.Context, string, ProjectInput) (Project, error)
	Get(context.Context, string) (Project, error)
	Save(context.Context, string, ProjectInput) (Project, error)
}
type ProjectListService interface {
	List(context.Context, string, int) (ProjectPage, error)
}
type ExportPreflightService interface {
	Preflight(context.Context, Project, ExportInput) (exporter.PreflightResult, error)
}
