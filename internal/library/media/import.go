package media

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"regexp"

	jobservice "videocutlist/internal/jobs"
	jobs "videocutlist/internal/jobs/model"
)

// ImportUseCase admits, reports, and cancels durable library scans.
type ImportUseCase struct {
	Configured  bool
	Scheduler   *jobservice.Scheduler
	UnifiedJobs *jobservice.JobsStore
}

func (m *ImportUseCase) StartImport(ctx context.Context, key string) (ImportJob, error) {
	if !m.Configured {
		return ImportJob{}, errors.New("media library is not configured")
	}
	if m.Scheduler == nil || m.UnifiedJobs == nil {
		return ImportJob{}, errors.New("unified job scheduler is not configured")
	}
	id, err := jobs.NewID("j_")
	if err != nil {
		return ImportJob{}, err
	}
	batchID, err := jobs.NewID("b_")
	if err != nil {
		return ImportJob{}, err
	}
	digest := sha256.Sum256([]byte(`{}`))
	admission, err := m.Scheduler.SubmitCommand(ctx, jobs.CommandAdmission{
		Key: key, Scope: "library-scan", Kind: "library-scan", Target: "library", Digest: hex.EncodeToString(digest[:]),
	}, []jobs.Job{{ID: id, BatchID: batchID, Kind: jobs.JobScan, RequestJSON: `{}`}})
	if err != nil {
		return ImportJob{}, err
	}
	return ImportJobResult(admission.Jobs[0]), nil
}

func (m *ImportUseCase) ImportStatus(ctx context.Context, id string) (ImportJob, error) {
	if m.UnifiedJobs == nil {
		return ImportJob{}, jobs.ErrJobNotFound
	}
	job, err := m.UnifiedJobs.Get(ctx, id)
	if err != nil {
		return ImportJob{}, err
	}
	if job.Kind != jobs.JobScan {
		return ImportJob{}, jobs.ErrJobNotFound
	}
	return ImportJobResult(job), nil
}

func (m *ImportUseCase) CancelImport(ctx context.Context, id string) error {
	if m.UnifiedJobs == nil || m.Scheduler == nil {
		return jobs.ErrJobNotFound
	}
	job, err := m.UnifiedJobs.Get(ctx, id)
	if err != nil {
		return err
	}
	if job.Kind != jobs.JobScan {
		return jobs.ErrJobNotFound
	}
	_, err = m.Scheduler.Cancel(ctx, id)
	if errors.Is(err, jobs.ErrJobState) {
		return nil
	}
	return err
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

// ImportJobResult projects a durable job without exposing unsafe persisted details.
func ImportJobResult(job jobs.Job) ImportJob {
	out := ImportJob{ID: job.ID, State: string(job.State), Progress: 0}
	if job.State == jobs.JobSucceeded {
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
