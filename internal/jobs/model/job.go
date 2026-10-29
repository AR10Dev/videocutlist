// Package model contains dependency-light durable job records and validation.
package model

import (
	"database/sql"
	"errors"
	"regexp"
	"time"
)

var (
	ErrJobNotFound       = errors.New("job not found")
	ErrNoQueuedJob       = errors.New("no queued job")
	ErrJobState          = errors.New("invalid job transition")
	ErrAdmissionConflict = errors.New("idempotency key conflicts with an accepted command")
	ErrQueueFull         = errors.New("job queue capacity exceeded")

	jobIDPattern           = regexp.MustCompile(`^j_[A-Za-z0-9_-]{12,64}$`)
	batchIDPattern         = regexp.MustCompile(`^b_[A-Za-z0-9_-]{12,64}$`)
	admissionKeyPattern    = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)
	admissionDigestPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)
)

// JobKind identifies durable work. All kinds share one state machine.
type JobKind string

type JobState string

const (
	JobQueued    JobState = "queued"
	JobRunning   JobState = "running"
	JobSucceeded JobState = "succeeded"
	JobFailed    JobState = "failed"
	JobCancelled JobState = "cancelled"

	JobExport JobKind = "export"
	JobDetect JobKind = "detection"
	JobScan   JobKind = "library_scan"
)

// Job is the durable, transport-neutral work record. Request and Result are
// opaque JSON payloads; callers must only put safe identifiers and metadata in them.
type Job struct {
	ID, BatchID, ProjectID, ProjectItemID string
	ProposalID, CredentialID              string
	Kind                                  JobKind
	State                                 JobState
	RequestJSON                           string
	ResultJSON, ErrorCode                 sql.NullString
	CreatedAt, UpdatedAt                  time.Time
	Revision                              int64
}

// CommandAdmission contains only a command's identity and semantic digest.
// It deliberately excludes authentication and request/response bodies.
type CommandAdmission struct {
	Key, Scope, Kind, Target, Digest string
}

// CommandAdmissionResult returns the original jobs for a replay, or the newly
// admitted jobs for a first delivery.
type CommandAdmissionResult struct {
	Jobs     []Job
	Replayed bool
}

// BatchPosition is the stable ordering position used for batch pagination.
type BatchPosition struct {
	ID        string
	CreatedAt string
}

// BatchCursorEntry is one ordered job component used to derive a snapshot cursor.
type BatchCursorEntry struct {
	ID       string
	Revision int64
	State    JobState
}

// BatchCounts contains the persisted state totals used by application-level batch projection.
type BatchCounts struct {
	Total, Terminal, Running, Failed, Cancelled int
}

// ValidCommandKey reports whether a key meets the bounded HTTP command-key syntax.
func ValidCommandKey(key string) bool { return admissionKeyPattern.MatchString(key) }

// ValidateCommandAdmission checks the pure command identity constraints.
func ValidateCommandAdmission(command CommandAdmission) error {
	if !ValidCommandKey(command.Key) || command.Scope == "" || command.Kind == "" || command.Target == "" || !admissionDigestPattern.MatchString(command.Digest) {
		return errors.New("valid command key, scope, kind, target, and digest are required")
	}
	return nil
}

// ValidateNewJob checks the durable identifier and job-kind constraints.
func ValidateNewJob(job Job) error {
	if !jobIDPattern.MatchString(job.ID) || !batchIDPattern.MatchString(job.BatchID) || job.RequestJSON == "" || !validJobKind(job.Kind) {
		return errors.New("valid job ID, batch ID, kind, and request are required")
	}
	if job.Kind != JobScan && (job.ProjectID == "" || job.ProjectItemID == "") {
		return errors.New("project job requires project and item")
	}
	if job.Kind == JobScan && (job.ProjectID != "" || job.ProjectItemID != "") {
		return errors.New("library scan cannot reference a project item")
	}
	return nil
}

// ValidateProposalJob checks that a proposal admission contains its bound export job.
func ValidateProposalJob(job Job, proposalID, credentialID string) error {
	if err := ValidateNewJob(job); err != nil || job.Kind != JobExport || job.ProposalID != proposalID || job.CredentialID != credentialID {
		return errors.New("invalid proposal export job")
	}
	return nil
}

func validJobKind(kind JobKind) bool {
	return kind == JobExport || kind == JobDetect || kind == JobScan
}
