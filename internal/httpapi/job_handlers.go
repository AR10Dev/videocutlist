// Package httpapi implements HTTP transport handlers.
package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	jobqueue "videocutlist/internal/jobs"
)

func (s *Server) getJob(writer http.ResponseWriter, request *http.Request, job string, id string) {
	if s.config.Jobs == nil {
		internalError(writer, id)
		return
	}
	value, err := s.config.Jobs.Get(request.Context(), job)
	if err != nil {
		if errors.Is(err, jobqueue.ErrJobNotFound) {
			notFound(writer, id)
		} else {
			internalError(writer, id)
		}
		return
	}
	httpx.WriteJSON(writer, 200, value)
}

const (
	jobStreamPollInterval = time.Second
	jobStreamHeartbeat    = 15 * time.Second
)

func (s *Server) streamJob(writer http.ResponseWriter, request *http.Request, jobID, requestID string) {
	if s.config.Jobs == nil {
		internalError(writer, requestID)
		return
	}
	streamContext, cancelStream := context.WithCancel(request.Context())
	stopShutdown := context.AfterFunc(s.shutdown, cancelStream)
	defer cancelStream()
	defer stopShutdown()
	job, err := s.config.Jobs.Get(streamContext, jobID)
	if err != nil {
		if errors.Is(err, jobqueue.ErrJobNotFound) {
			notFound(writer, requestID)
		} else {
			internalError(writer, requestID)
		}
		return
	}
	if job.ID != jobID {
		internalError(writer, requestID)
		return
	}

	resync := false
	lastEventIDs := request.Header.Values("Last-Event-ID")
	if len(lastEventIDs) > 0 {
		resync = true
		if len(lastEventIDs) == 1 {
			if cursor, ok := parseJobCursor(lastEventIDs[0], jobID); ok {
				resync = cursor != job.SnapshotCursor()
			}
		}
	}

	writer.Header().Set("Content-Type", "text/event-stream")
	writer.Header().Set("Cache-Control", "no-cache")
	writer.Header().Set("X-Accel-Buffering", "no")
	flush := http.NewResponseController(writer).Flush
	if resync {
		if !writeJobEvent(writer, flush, "resync", job) {
			return
		}
	} else if !writeJobEvent(writer, flush, "snapshot", job) {
		return
	}
	if terminalJob(job.State) {
		return
	}

	poll := time.NewTicker(jobStreamPollInterval)
	defer poll.Stop()
	heartbeat := time.NewTicker(jobStreamHeartbeat)
	defer heartbeat.Stop()
	for {
		select {
		case <-streamContext.Done():
			return
		case <-heartbeat.C:
			if err := s.config.Authenticator.Authenticate(request); err != nil {
				return
			}
			if _, err := fmt.Fprint(writer, ": keepalive\n\n"); err != nil || flush() != nil {
				return
			}
		case <-poll.C:
			current, err := s.config.Jobs.Get(streamContext, jobID)
			if err != nil || current.ID != jobID {
				_, _ = fmt.Fprint(writer, "event: error\ndata: {\"code\":\"observation_failed\"}\n\n")
				_ = flush()
				return
			}
			if current.SnapshotCursor() != job.SnapshotCursor() {
				if !writeJobEvent(writer, flush, "snapshot", current) {
					return
				}
				job = current
				if terminalJob(job.State) {
					return
				}
			}
		}
	}
}

func parseJobCursor(cursor, jobID string) (string, bool) {
	if len(cursor) == 0 || len(cursor) > 256 {
		return "", false
	}
	resource, revisionText, ok := strings.Cut(cursor, ":")
	if !ok || resource != jobID {
		return "", false
	}
	revision, err := strconv.ParseInt(revisionText, 10, 64)
	if err != nil || revision < 1 || strconv.FormatInt(revision, 10) != revisionText {
		return "", false
	}
	return cursor, true
}

func writeJobEvent(writer http.ResponseWriter, flush func() error, event string, job Job) bool {
	data, err := json.Marshal(job)
	if err != nil {
		return false
	}
	if _, err := fmt.Fprintf(writer, "id: %s\nevent: %s\ndata: %s\n\n", job.SnapshotCursor(), event, data); err != nil {
		return false
	}
	return flush() == nil
}

func terminalJob(state string) bool {
	return state == "succeeded" || state == "failed" || state == "cancelled"
}

func (s *Server) cancelJob(writer http.ResponseWriter, request *http.Request, job string, id string) {
	if s.config.Jobs == nil {
		internalError(writer, id)
		return
	}
	if err := s.config.Jobs.Cancel(request.Context(), job); err != nil {
		if errors.Is(err, jobqueue.ErrJobNotFound) {
			notFound(writer, id)
		} else {
			internalError(writer, id)
		}
		return
	}
	writer.WriteHeader(http.StatusNoContent)
}
