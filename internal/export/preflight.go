package export

import (
	"context"
	"errors"
	"fmt"
	"os"
	"slices"

	"videocutlist/internal/library/media/probe"
)

type Finding struct {
	Severity    string `json:"severity"`
	Code        string `json:"code"`
	Message     string `json:"message"`
	StreamIndex *int   `json:"streamIndex,omitempty"`
}
type PreflightResult struct {
	Allowed   bool      `json:"allowed"`
	Selection []int     `json:"selection"`
	Findings  []Finding `json:"findings"`
}

// Preflight is the single export stream policy. Empty selection deterministically
// chooses video, audio, and subtitle streams; data and attachments never pass.
func Preflight(request Request, metadata probe.Metadata) PreflightResult {
	result := PreflightResult{Selection: slices.Clone(request.StreamIndexes)}
	if request.Selection == "" {
		request.Selection = "segments"
	}
	if request.Mode != "merge" && request.Mode != "separate" {
		result.Findings = append(result.Findings, Finding{Severity: "blocked", Code: "unsupported_mode", Message: "mode must be merge or separate"})
	}
	if request.Container != "mkv" {
		result.Findings = append(result.Findings, Finding{Severity: "blocked", Code: "unsupported_container", Message: "only MKV exports are supported"})
	}
	if _, err := RenderTemplate(request.FilenameTemplate, map[string]string{
		"source": "source", "date": "20000101", "time": "000000", "segment": "1", "mode": request.Mode, "ext": "mkv",
	}); err != nil {
		result.Findings = append(result.Findings, Finding{Severity: "blocked", Code: "invalid_filename_template", Message: err.Error()})
	}
	switch request.CutStrategy {
	case "stream_copy_preferred", "precise_reencode", "hybrid_smart_cut":
	default:
		result.Findings = append(result.Findings, Finding{Severity: "blocked", Code: "unsupported_strategy", Message: "unsupported cut strategy"})
	}
	if len(request.StreamIndexes) == 0 {
		result.Selection = nil
		for _, stream := range metadata.Streams {
			if stream.Type == "video" || stream.Type == "audio" || stream.Type == "subtitle" {
				result.Selection = append(result.Selection, stream.Index)
			}
		}
		result.Findings = append(result.Findings, Finding{Severity: "allowed", Code: "default_stream_selection", Message: "Selected video, audio, and subtitle streams by default."})
	} else {
		seen := map[int]bool{}
		byIndex := map[int]probe.Stream{}
		for _, stream := range metadata.Streams {
			byIndex[stream.Index] = stream
		}
		for _, index := range request.StreamIndexes {
			if seen[index] {
				result.Findings = append(result.Findings, Finding{Severity: "blocked", Code: "duplicate_stream_index", Message: fmt.Sprintf("stream index %d is duplicated", index), StreamIndex: &index})
				continue
			}
			seen[index] = true
			stream, ok := byIndex[index]
			if !ok {
				result.Findings = append(result.Findings, Finding{Severity: "blocked", Code: "unknown_stream_index", Message: fmt.Sprintf("stream index %d does not exist", index), StreamIndex: &index})
				continue
			}
			if stream.Type != "video" && stream.Type != "audio" && stream.Type != "subtitle" {
				result.Findings = append(result.Findings, Finding{Severity: "blocked", Code: "forbidden_stream_type", Message: "attachments and data streams cannot be exported", StreamIndex: &index})
				continue
			}
		}
	}
	if len(result.Selection) == 0 {
		result.Findings = append(result.Findings, Finding{Severity: "blocked", Code: "no_allowed_streams", Message: "at least one video, audio, or subtitle stream is required"})
	}
	for _, finding := range result.Findings {
		if finding.Severity == "blocked" {
			return result
		}
	}
	result.Allowed = true
	return result
}

func (s Service) preflightDestination(ctx context.Context, request Request, source *os.File) error {
	if !atomicNoReplacePublicationSupported() {
		return errAtomicNoReplaceUnsupported
	}
	destination := Destination{ID: "download", Kind: KindDownload, Root: s.OutputDir, Retention: s.Retention}
	for _, candidate := range s.Destinations {
		if candidate.ID == request.DestinationID || request.DestinationID == "" && candidate.ID == "download" {
			destination = candidate
			break
		}
	}
	if request.DestinationID != "" && destination.ID != request.DestinationID {
		return fmt.Errorf("unknown destination %q", request.DestinationID)
	}
	prepared, err := prepareDestination(destination, source, requestSourceName(source, request), SourceLocation{RootPath: request.SourceRoot, RelativePath: request.SourceRelative})
	if err != nil {
		return err
	}
	defer prepared.close()
	if err := ctx.Err(); err != nil {
		return err
	}
	temporary, temporaryName, err := prepared.createTemp(".videocutlist-preflight-", ".tmp")
	if err != nil {
		return err
	}
	defer prepared.remove(temporaryName)
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return err
	}
	return temporary.Close()
}

func (s Service) Preflight(ctx context.Context, source *os.File, request Request) (PreflightResult, error) {
	if source == nil {
		return PreflightResult{}, fmt.Errorf("export source is required")
	}
	metadata, err := (probe.Client{Path: s.FFprobePath}).ProbeFile(ctx, source)
	if err != nil {
		return PreflightResult{}, fmt.Errorf("probe export source: %w", err)
	}
	result := Preflight(request, metadata)
	if request.SourceSizeBytes > 0 || request.SourceMtimeNS > 0 {
		info, statErr := source.Stat()
		if statErr != nil || request.SourceSizeBytes > 0 && info.Size() != request.SourceSizeBytes || request.SourceMtimeNS > 0 && info.ModTime().UnixNano() != request.SourceMtimeNS {
			result.Allowed = false
			result.Findings = append(result.Findings, Finding{Severity: "blocked", Code: "source_changed", Message: "The source changed while export requirements were checked."})
			return result, nil
		}
	}
	if err := s.preflightDestination(ctx, request, source); err != nil {
		result.Allowed = false
		if errors.Is(err, errAtomicNoReplaceUnsupported) {
			result.Findings = append(result.Findings, Finding{Severity: "blocked", Code: "unsupported_publication_platform", Message: unsupportedPublicationMessage})
		} else {
			result.Findings = append(result.Findings, Finding{Severity: "blocked", Code: "invalid_destination", Message: "The selected destination is unavailable or not writable."})
		}
	}
	return result, nil
}

func sortedIndexes(streams []probe.Stream) []int {
	out := make([]int, 0, len(streams))
	for _, s := range streams {
		out = append(out, s.Index)
	}
	slices.Sort(out)
	return out
}
