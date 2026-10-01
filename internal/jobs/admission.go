package jobs

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"time"
)

var (
	ErrAdmissionConflict   = errors.New("idempotency key conflicts with an accepted command")
	admissionKeyPattern    = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)
	admissionDigestPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)
)

// CommandAdmission contains only the identity and semantic digest of a command.
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

// SubmitCommand atomically records a command identity and its jobs. The
// idempotency namespace is the deployment-local command scope plus key.
func (s *Scheduler) SubmitCommand(ctx context.Context, command CommandAdmission, jobs []Job) (out CommandAdmissionResult, err error) {
	ctx, cancel := s.requestContext(ctx)
	defer cancel()
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.stopped {
		return out, ErrSchedulerStopped
	}
	if !admissionKeyPattern.MatchString(command.Key) || command.Scope == "" || command.Kind == "" || command.Target == "" || !admissionDigestPattern.MatchString(command.Digest) {
		return out, errors.New("valid command key, scope, kind, target, and digest are required")
	}
	if len(jobs) == 0 {
		return out, errors.New("command must admit at least one job")
	}
	tx, err := s.jobs.db.BeginTx(ctx, nil)
	if err != nil {
		return out, err
	}
	defer func() {
		if rollbackErr := tx.Rollback(); rollbackErr != nil && !errors.Is(rollbackErr, sql.ErrTxDone) {
			err = errors.Join(err, fmt.Errorf("rollback command admission: %w", rollbackErr))
		}
	}()

	references := make([]string, len(jobs))
	for i := range jobs {
		references[i] = jobs[i].ID
	}
	referencesJSON, err := json.Marshal(references)
	if err != nil {
		return out, err
	}
	now := time.Now().UTC()
	stamp := now.Format(time.RFC3339Nano)
	_, insertErr := tx.ExecContext(ctx, `INSERT INTO command_admissions (command_scope,idempotency_key,command_kind,command_target,payload_digest,resource_refs_json,created_at) VALUES (?,?,?,?,?,?,?)`, command.Scope, command.Key, command.Kind, command.Target, command.Digest, string(referencesJSON), stamp)
	if insertErr != nil {
		replay, replayErr := readCommandAdmission(ctx, tx, command)
		if replayErr == nil {
			if err := tx.Commit(); err != nil {
				return out, err
			}
			replay.Replayed = true
			return replay, nil
		}
		if !errors.Is(replayErr, sql.ErrNoRows) {
			return out, replayErr
		}
		return out, fmt.Errorf("record command admission: %w", insertErr)
	}
	if len(jobs) > s.config.QueueCapacity {
		return out, ErrQueueFull
	}
	for _, job := range jobs {
		if err := validateNewJob(job); err != nil {
			return out, err
		}
	}
	var queued int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM jobs WHERE state IN ('queued','running')`).Scan(&queued); err != nil {
		return out, err
	}
	if queued+len(jobs) > s.config.QueueCapacity {
		return out, ErrQueueFull
	}
	out.Jobs = make([]Job, len(jobs))
	for i, job := range jobs {
		if _, err := tx.ExecContext(ctx, `INSERT INTO jobs (id,batch_id,kind,project_id,project_item_id,proposal_id,credential_id,state,request_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`, job.ID, job.BatchID, job.Kind, nullString(job.ProjectID), nullString(job.ProjectItemID), nullString(job.ProposalID), nullString(job.CredentialID), JobQueued, job.RequestJSON, stamp, stamp); err != nil {
			return CommandAdmissionResult{}, fmt.Errorf("create command job: %w", err)
		}
		out.Jobs[i] = queuedJob(job, now)
	}
	if err := tx.Commit(); err != nil {
		return CommandAdmissionResult{}, err
	}
	if s.afterCommit != nil {
		s.afterCommit()
	}
	s.signal()
	return out, nil
}

type admissionQueryer interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func readCommandAdmission(ctx context.Context, queryer admissionQueryer, command CommandAdmission) (CommandAdmissionResult, error) {
	var kind, target, digest, referencesJSON string
	if err := queryer.QueryRowContext(ctx, `SELECT command_kind,command_target,payload_digest,resource_refs_json FROM command_admissions WHERE command_scope=? AND idempotency_key=?`, command.Scope, command.Key).Scan(&kind, &target, &digest, &referencesJSON); err != nil {
		return CommandAdmissionResult{}, err
	}
	if kind != command.Kind || target != command.Target || digest != command.Digest {
		return CommandAdmissionResult{}, ErrAdmissionConflict
	}
	var references []string
	if err := json.Unmarshal([]byte(referencesJSON), &references); err != nil || len(references) == 0 {
		return CommandAdmissionResult{}, errors.New("invalid stored command references")
	}
	result := CommandAdmissionResult{Jobs: make([]Job, 0, len(references))}
	for _, id := range references {
		job, err := scanUnifiedJob(queryer.QueryRowContext(ctx, `SELECT id,batch_id,kind,COALESCE(project_id,''),COALESCE(project_item_id,''),COALESCE(proposal_id,''),COALESCE(credential_id,''),state,request_json,result_json,error_code,created_at,updated_at FROM jobs WHERE id=?`, id))
		if err != nil {
			return CommandAdmissionResult{}, fmt.Errorf("load admitted command job: %w", err)
		}
		result.Jobs = append(result.Jobs, job)
	}
	return result, nil
}
