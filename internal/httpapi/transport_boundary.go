package httpapi

import (
	"fmt"
	"net/http"
	"time"

	"github.com/oapi-codegen/nullable"
	"videocutlist/internal/detection"
	"videocutlist/internal/export"
	"videocutlist/internal/httpapi/transport"
	"videocutlist/internal/jobs/view"
	"videocutlist/internal/projects"
	"videocutlist/internal/projects/model"
)

func domainExportInput(input transport.ExportInput) projects.ExportInput {
	mapped := projects.ExportInput{
		Mode: string(input.Mode), Selection: string(input.Selection), CutStrategy: string(input.CutStrategy),
		Container: string(input.Container),
	}
	if input.StreamIndexes != nil {
		mapped.StreamIndexes = *input.StreamIndexes
	}
	if input.DestinationId != nil {
		mapped.DestinationID = *input.DestinationId
	}
	if input.FilenameTemplate != nil {
		mapped.FilenameTemplate = *input.FilenameTemplate
	}
	if input.ItemIds != nil {
		mapped.ItemIDs = *input.ItemIds
	}
	return mapped
}

func domainDetectionRequest(input transport.DetectionInput) detection.Request {
	mapped := detection.Request{
		MediaID: input.MediaId, ProjectItemID: input.ProjectItemId,
		ProjectRevision: int64(input.ProjectRevision), Kind: model.DetectionKind(input.Kind),
	}
	if input.SourceFingerprint != nil {
		mapped.SourceFingerprint = *input.SourceFingerprint
	}
	if input.NoiseDb != nil {
		mapped.NoiseDB = *input.NoiseDb
	}
	if input.MinDurationMs != nil {
		mapped.MinDurationMS = int64(*input.MinDurationMs)
	}
	if input.SceneThreshold != nil {
		mapped.SceneThreshold = *input.SceneThreshold
	}
	return mapped
}

func transportInteger(value int64) (int, bool) {
	mapped := int(value)
	return mapped, int64(mapped) == value
}

func exportCapabilitiesTransport(result export.Capabilities) transport.ExportCapabilities {
	mapped := transport.ExportCapabilities{Strategies: make([]transport.ExportStrategyCapability, 0, len(result.Strategies))}
	for _, strategy := range result.Strategies {
		item := transport.ExportStrategyCapability{
			Strategy:  transport.ExportStrategyCapabilityStrategy(strategy.Strategy),
			Supported: strategy.Supported,
			Reasons:   make([]transport.ExportStrategyCapabilityReasons, len(strategy.Reasons)),
		}
		for i, reason := range strategy.Reasons {
			item.Reasons[i] = transport.ExportStrategyCapabilityReasons(reason)
		}
		mapped.Strategies = append(mapped.Strategies, item)
	}
	return mapped
}

func exportPreflightTransport(result export.PreflightResult) transport.ExportPreflight {
	mapped := transport.ExportPreflight{Allowed: result.Allowed}
	if result.Selection != nil {
		mapped.Selection = make([]int, len(result.Selection))
		copy(mapped.Selection, result.Selection)
	}
	if result.Findings != nil {
		mapped.Findings = make([]transport.ExportFinding, len(result.Findings))
		for index, finding := range result.Findings {
			mapped.Findings[index] = transport.ExportFinding{
				Code: finding.Code, Message: finding.Message,
				Severity: transport.ExportFindingSeverity(finding.Severity), StreamIndex: finding.StreamIndex,
			}
		}
	}
	return mapped
}

func detectionCandidateTransport(candidate model.Candidate) (transport.DetectionCandidate, bool, error) {
	var mapped transport.DetectionCandidate
	if candidate.Source == model.DetectScene {
		point := candidate.PointMS
		if point == nil && candidate.EndMS > candidate.StartMS && candidate.EndMS-candidate.StartMS == 1 {
			point = new(candidate.StartMS)
		}
		if point == nil {
			return mapped, false, nil
		}
		pointMS, ok := transportInteger(*point)
		if !ok {
			return mapped, false, fmt.Errorf("detection point exceeds transport integer range")
		}
		revision, ok := transportInteger(candidate.ProjectRevision)
		if !ok {
			return mapped, false, fmt.Errorf("detection revision exceeds transport integer range")
		}
		concrete := transport.DetectionPointCandidate{
			Id: candidate.ID, MediaId: candidate.MediaID, PointMs: pointMS,
			ProjectId: candidate.ProjectID, ProjectRevision: revision,
			Source: transport.DetectionPointCandidateSource(candidate.Source),
		}
		return mapped, true, mapped.FromDetectionPointCandidate(concrete)
	}
	startMS, ok := transportInteger(candidate.StartMS)
	if !ok {
		return mapped, false, fmt.Errorf("detection start exceeds transport integer range")
	}
	endMS, ok := transportInteger(candidate.EndMS)
	if !ok {
		return mapped, false, fmt.Errorf("detection end exceeds transport integer range")
	}
	revision, ok := transportInteger(candidate.ProjectRevision)
	if !ok {
		return mapped, false, fmt.Errorf("detection revision exceeds transport integer range")
	}
	concrete := transport.DetectionRangeCandidate{
		EndMs: endMS, Id: candidate.ID, MediaId: candidate.MediaID,
		ProjectId: candidate.ProjectID, ProjectRevision: revision,
		Source: transport.DetectionRangeCandidateSource(candidate.Source), StartMs: startMS,
	}
	return mapped, true, mapped.FromDetectionRangeCandidate(concrete)
}

func jobResultTransport(result view.JobResult) *struct {
	AppliedStrategies *[]struct {
		OutputName *string `json:"outputName,omitempty"`
		Segment    int     `json:"segment"`
		Strategy   string  `json:"strategy"`
	} `json:"appliedStrategies,omitempty"`
	Container       *transport.JobResultContainer       `json:"container,omitempty"`
	DestinationId   *string                             `json:"destinationId,omitempty"` //nolint:revive // Must match the generated Job.Result anonymous type.
	DestinationKind *transport.JobResultDestinationKind `json:"destinationKind,omitempty"`
	OutputFailures  *[]struct {
		Code    string `json:"code"`
		Message string `json:"message"`
		Segment int    `json:"segment"`
	} `json:"outputFailures,omitempty"`
	OutputName  *string   `json:"outputName,omitempty"`
	OutputNames *[]string `json:"outputNames,omitempty"`
	RetainUntil time.Time `json:"retainUntil"`
	SizeBytes   int64     `json:"sizeBytes"`
} {
	mapped := &struct {
		AppliedStrategies *[]struct {
			OutputName *string `json:"outputName,omitempty"`
			Segment    int     `json:"segment"`
			Strategy   string  `json:"strategy"`
		} `json:"appliedStrategies,omitempty"`
		Container       *transport.JobResultContainer       `json:"container,omitempty"`
		DestinationId   *string                             `json:"destinationId,omitempty"` //nolint:revive // Must match the generated Job.Result anonymous type.
		DestinationKind *transport.JobResultDestinationKind `json:"destinationKind,omitempty"`
		OutputFailures  *[]struct {
			Code    string `json:"code"`
			Message string `json:"message"`
			Segment int    `json:"segment"`
		} `json:"outputFailures,omitempty"`
		OutputName  *string   `json:"outputName,omitempty"`
		OutputNames *[]string `json:"outputNames,omitempty"`
		RetainUntil time.Time `json:"retainUntil"`
		SizeBytes   int64     `json:"sizeBytes"`
	}{RetainUntil: result.RetainUntil, SizeBytes: result.SizeBytes}
	if result.Container != "" {
		container := transport.JobResultContainer(result.Container)
		mapped.Container = &container
	}
	if result.DestinationID != "" {
		mapped.DestinationId = &result.DestinationID
	}
	if result.DestinationKind != "" {
		kind := transport.JobResultDestinationKind(result.DestinationKind)
		mapped.DestinationKind = &kind
	}
	if result.OutputName != "" {
		mapped.OutputName = &result.OutputName
	}
	if len(result.OutputNames) > 0 {
		values := make([]string, len(result.OutputNames))
		copy(values, result.OutputNames)
		mapped.OutputNames = &values
	}
	if len(result.OutputFailures) > 0 {
		values := make([]struct {
			Code    string `json:"code"`
			Message string `json:"message"`
			Segment int    `json:"segment"`
		}, len(result.OutputFailures))
		for index, failure := range result.OutputFailures {
			values[index] = struct {
				Code    string `json:"code"`
				Message string `json:"message"`
				Segment int    `json:"segment"`
			}{Code: failure.Code, Message: failure.Message, Segment: failure.Segment}
		}
		mapped.OutputFailures = &values
	}
	if len(result.AppliedStrategies) > 0 {
		values := make([]struct {
			OutputName *string `json:"outputName,omitempty"`
			Segment    int     `json:"segment"`
			Strategy   string  `json:"strategy"`
		}, len(result.AppliedStrategies))
		for index, applied := range result.AppliedStrategies {
			values[index] = struct {
				OutputName *string `json:"outputName,omitempty"`
				Segment    int     `json:"segment"`
				Strategy   string  `json:"strategy"`
			}{Segment: applied.Segment, Strategy: applied.Strategy}
			if applied.OutputName != "" {
				values[index].OutputName = &applied.OutputName
			}
		}
		mapped.AppliedStrategies = &values
	}
	return mapped
}

func jobTransport(job view.Job) (transport.Job, bool, error) {
	if len(job.RootResults) > 0 || len(job.Candidates) > 0 {
		return transport.Job{}, false, nil
	}
	revision, ok := transportInteger(job.Revision)
	if !ok {
		return transport.Job{}, false, fmt.Errorf("job revision exceeds transport integer range")
	}
	mapped := transport.Job{
		Id: job.ID, CreatedAt: job.CreatedAt, Revision: revision,
		State: transport.JobState(job.State), Type: transport.JobType(job.Type), UpdatedAt: job.UpdatedAt,
		Progress: new(job.Progress), ErrorCode: job.ErrorCode,
	}
	if job.BatchID != "" {
		mapped.BatchId = &job.BatchID
	}
	if job.ProjectItemID != "" {
		mapped.ProjectItemId = &job.ProjectItemID
	}
	if job.MediaLabel != "" {
		mapped.MediaLabel = &job.MediaLabel
	}
	if job.Strategy != "" {
		mapped.Strategy = &job.Strategy
	}
	if job.Container != "" {
		container := transport.JobContainer(job.Container)
		mapped.Container = &container
	}
	if job.AppliedStrategy != "" {
		mapped.AppliedStrategy = &job.AppliedStrategy
	}
	if job.Mode != "" {
		mode := transport.JobMode(job.Mode)
		mapped.Mode = &mode
	}
	if job.Selection != "" {
		selection := transport.JobSelection(job.Selection)
		mapped.Selection = &selection
	}
	if job.ProjectRevision != 0 {
		projectRevision, ok := transportInteger(job.ProjectRevision)
		if !ok {
			return transport.Job{}, false, fmt.Errorf("job project revision exceeds transport integer range")
		}
		mapped.ProjectRevision = &projectRevision
	}
	if job.MediaID != "" {
		mapped.MediaId = &job.MediaID
	}
	if job.ProjectID != "" {
		mapped.ProjectId = &job.ProjectID
	}
	if job.Kind != "" {
		kind := string(job.Kind)
		mapped.Kind = &kind
	}
	if job.Result != nil {
		mapped.Result = jobResultTransport(*job.Result)
	}
	if len(job.SelectedStreams) > 0 {
		streams := make([]int, len(job.SelectedStreams))
		copy(streams, job.SelectedStreams)
		mapped.SelectedStreams = &streams
	}
	if job.Verified {
		mapped.Verified = new(job.Verified)
	}
	if len(job.Warnings) > 0 {
		warnings := make([]string, len(job.Warnings))
		copy(warnings, job.Warnings)
		mapped.Warnings = &warnings
	}
	if len(job.WarningDetails) > 0 {
		findings := make([]struct {
			Code        string `json:"code"`
			Message     string `json:"message"`
			Severity    string `json:"severity"`
			StreamIndex *int   `json:"streamIndex,omitempty"`
		}, len(job.WarningDetails))
		for index, finding := range job.WarningDetails {
			findings[index] = struct {
				Code        string `json:"code"`
				Message     string `json:"message"`
				Severity    string `json:"severity"`
				StreamIndex *int   `json:"streamIndex,omitempty"`
			}{Code: finding.Code, Message: finding.Message, Severity: finding.Severity, StreamIndex: finding.StreamIndex}
		}
		mapped.WarningDetails = &findings
	}
	return mapped, true, nil
}

func writeDomainJobResponse(writer http.ResponseWriter, status int, job view.Job) {
	// The generated Job omits rootResults and candidates; retain the domain JSON until the contract represents them.
	httpx.WriteJSON(writer, status, job)
}

func writeJobJSON(writer http.ResponseWriter, status int, requestID string, job view.Job) {
	mapped, ok, err := jobTransport(job)
	if err != nil {
		internalError(writer, requestID, err)
		return
	}
	if !ok {
		writeDomainJobResponse(writer, status, job)
		return
	}
	httpx.WriteJSON(writer, status, mapped)
}

func detectionJobTransport(job detection.Job) (transport.DetectionJob, bool, error) {
	revision, ok := transportInteger(job.ProjectRevision)
	if !ok {
		return transport.DetectionJob{}, false, fmt.Errorf("detection job revision exceeds transport integer range")
	}
	mapped := transport.DetectionJob{
		Id: job.ID, Kind: transport.DetectionJobKind(job.Kind), MediaId: job.MediaID,
		ProjectId: job.ProjectID, ProjectRevision: revision,
		State: transport.DetectionJobState(job.State), Type: transport.DetectionJobType(job.Type),
	}
	if len(job.Candidates) > 0 {
		candidates := make([]transport.DetectionCandidate, len(job.Candidates))
		for index, candidate := range job.Candidates {
			mappedCandidate, representable, err := detectionCandidateTransport(candidate)
			if err != nil || !representable {
				return mapped, false, err
			}
			candidates[index] = mappedCandidate
		}
		mapped.Candidates = &candidates
	}
	mapped.ErrorCode = job.ErrorCode
	return mapped, true, nil
}

func writeDetectionJobJSON(writer http.ResponseWriter, status int, requestID string, job detection.Job) {
	mapped, ok, err := detectionJobTransport(job)
	if err != nil {
		internalError(writer, requestID, err)
		return
	}
	if !ok {
		// An invalid legacy scene candidate lacks pointMs; retain its domain JSON rather than inventing a value.
		httpx.WriteJSON(writer, status, job)
		return
	}
	httpx.WriteJSON(writer, status, mapped)
}

func batchTransport(batch projects.Batch) (transport.Batch, bool, error) {
	mapped := transport.Batch{
		BatchId: batch.BatchID, State: transport.BatchState(batch.State), Progress: batch.Progress,
	}
	if batch.ProjectID != "" {
		mapped.ProjectId = &batch.ProjectID
	}
	if batch.ProjectRevision != 0 {
		revision, ok := transportInteger(batch.ProjectRevision)
		if !ok {
			return transport.Batch{}, false, fmt.Errorf("batch project revision exceeds transport integer range")
		}
		mapped.ProjectRevision = &revision
	}
	if batch.Jobs != nil {
		mapped.Jobs = make([]transport.Job, len(batch.Jobs))
		for index, job := range batch.Jobs {
			mappedJob, representable, err := jobTransport(job)
			if err != nil || !representable {
				return transport.Batch{}, false, err
			}
			mapped.Jobs[index] = mappedJob
		}
	}
	return mapped, true, nil
}

func batchPageTransport(page projects.BatchPage) (transport.BatchPage, bool, error) {
	mapped := transport.BatchPage{}
	if page.NextCursor == nil {
		mapped.NextCursor = nullable.NewNullNullable[string]()
	} else {
		mapped.NextCursor = nullable.NewNullableWithValue(*page.NextCursor)
	}
	if page.Items != nil {
		mapped.Items = make([]transport.Batch, len(page.Items))
		for index, batch := range page.Items {
			mappedBatch, representable, err := batchTransport(batch)
			if err != nil || !representable {
				return transport.BatchPage{}, false, err
			}
			mapped.Items[index] = mappedBatch
		}
	}
	return mapped, true, nil
}

func writeBatchPageJSON(writer http.ResponseWriter, requestID string, page projects.BatchPage) {
	mapped, ok, err := batchPageTransport(page)
	if err != nil {
		internalError(writer, requestID, err)
		return
	}
	if !ok {
		// The domain response preserves extra job fields omitted by the generated Job DTO.
		httpx.WriteJSON(writer, http.StatusOK, page)
		return
	}
	httpx.WriteJSON(writer, http.StatusOK, mapped)
}

func writeBatchJSON(writer http.ResponseWriter, status int, requestID string, batch projects.Batch) {
	mapped, ok, err := batchTransport(batch)
	if err != nil {
		internalError(writer, requestID, err)
		return
	}
	if !ok {
		// The domain response preserves extra job fields omitted by the generated Job DTO.
		httpx.WriteJSON(writer, status, batch)
		return
	}
	httpx.WriteJSON(writer, status, mapped)
}

// batchExportSubmissionDomainResponse preserves fields missing from generated Job without changing its envelope.
type batchExportSubmissionDomainResponse struct {
	BatchID string     `json:"batchId"`
	Jobs    []view.Job `json:"jobs"`
}

func writeBatchExportSubmissionJSON(writer http.ResponseWriter, requestID, batchID string, jobs []view.Job) {
	var mappedJobs []transport.Job
	if jobs != nil {
		mappedJobs = make([]transport.Job, len(jobs))
	}
	for index, job := range jobs {
		mapped, ok, err := jobTransport(job)
		if err != nil {
			internalError(writer, requestID, err)
			return
		}
		if !ok {
			httpx.WriteJSON(writer, http.StatusAccepted, batchExportSubmissionDomainResponse{BatchID: batchID, Jobs: jobs})
			return
		}
		mappedJobs[index] = mapped
	}
	httpx.WriteJSON(writer, http.StatusAccepted, transport.BatchExportSubmission{BatchId: batchID, Jobs: mappedJobs})
}
