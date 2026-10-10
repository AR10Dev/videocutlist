package jobs

import (
	"context"
	"errors"

	"videocutlist/internal/jobs/model"
)

// LookupCommand reads an accepted command without reserving a fresh key.
func (s *Scheduler) LookupCommand(ctx context.Context, command model.CommandAdmission) (model.CommandAdmissionResult, bool, error) {
	ctx, cancel := s.requestContext(ctx)
	defer cancel()
	if err := model.ValidateCommandAdmission(command); err != nil {
		return model.CommandAdmissionResult{}, false, err
	}
	return s.jobs.storage.LookupCommand(ctx, command)
}

// SubmitCommand atomically records a command identity and its jobs. The
// idempotency namespace is the deployment-local command scope plus key.
func (s *Scheduler) SubmitCommand(ctx context.Context, command model.CommandAdmission, jobs []model.Job) (model.CommandAdmissionResult, error) {
	ctx, cancel := s.requestContext(ctx)
	defer cancel()
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.stopped {
		return model.CommandAdmissionResult{}, ErrSchedulerStopped
	}
	if err := model.ValidateCommandAdmission(command); err != nil {
		return model.CommandAdmissionResult{}, err
	}
	if len(jobs) == 0 {
		return model.CommandAdmissionResult{}, errors.New("command must admit at least one job")
	}
	result, err := s.jobs.storage.AdmitCommand(ctx, command, jobs, s.config.QueueCapacity)
	if err != nil {
		return model.CommandAdmissionResult{}, err
	}
	if !result.Replayed {
		if s.afterCommit != nil {
			s.afterCommit()
		}
		s.signal()
	}
	return result, nil
}
