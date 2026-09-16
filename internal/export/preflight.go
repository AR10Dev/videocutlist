package export

import (
	"context"
	"errors"
	"fmt"
	"os"
	"slices"

	"videocutlist/internal/exportpolicy"
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
	policy, policyOK := exportpolicy.For(request.Container)
	if !policyOK {
		result.Findings = append(result.Findings, Finding{Severity: "blocked", Code: "unsupported_container", Message: "container must be MKV, MP4, or MOV"})
		policy = exportpolicy.Policy{Extension: "mkv"}
	}
	if request.Mode != "merge" && request.Mode != "separate" {
		result.Findings = append(result.Findings, Finding{Severity: "blocked", Code: "unsupported_mode", Message: "mode must be merge or separate"})
	}
	if _, err := RenderTemplate(request.FilenameTemplate, map[string]string{
		"source": "source", "date": "20000101", "time": "000000", "segment": "1", "mode": request.Mode, "ext": policy.Extension,
	}); err != nil {
		result.Findings = append(result.Findings, Finding{Severity: "blocked", Code: "invalid_filename_template", Message: err.Error()})
	}
	switch request.CutStrategy {
	case "stream_copy_preferred":
		result.Findings = append(result.Findings, Finding{Severity: "warn", Code: "stream_copy_boundaries", Message: "Stream-copy boundaries follow keyframes and may not be frame-exact."})
	case "precise_reencode":
		result.Findings = append(result.Findings, Finding{Severity: "warn", Code: "reencode_required", Message: fmt.Sprintf("Precise %s output re-encodes video with software H.264 and audio with AAC before publication.", policy.Name)})
	case "hybrid_smart_cut":
		if policyOK && policy.Name != "mkv" {
			result.Findings = append(result.Findings, Finding{Severity: "blocked", Code: "unsupported_strategy_container", Message: "Hybrid Smart Cut is supported only for MKV output."})
		} else {
			result.Findings = append(result.Findings, Finding{Severity: "warn", Code: "hybrid_reencode_required", Message: "Hybrid Smart Cut re-encodes leading H.264 video boundaries and AAC audio; fallback stream-copy boundaries may not be frame-exact."})
		}
	default:
		result.Findings = append(result.Findings, Finding{Severity: "blocked", Code: "unsupported_strategy", Message: "unsupported cut strategy"})
	}
	byIndex := map[int]probe.Stream{}
	for _, stream := range metadata.Streams {
		byIndex[stream.Index] = stream
	}
	appendCompatibility := func(index int, stream probe.Stream) {
		if !policyOK || policy.Name == "mkv" {
			return
		}
		if request.CutStrategy == "stream_copy_preferred" && !policy.SupportsStreamCopy(stream.Type, stream.Codec) {
			result.Findings = append(result.Findings, Finding{Severity: "blocked", Code: "incompatible_stream", Message: fmt.Sprintf("Stream %d (%s/%s) cannot be stream-copied into %s; select H.264 video or AAC audio, or choose precise encoding.", index, stream.Type, stream.Codec, policy.Name), StreamIndex: &index})
		}
		if request.CutStrategy == "precise_reencode" && !policy.SupportsPrecise(stream.Type) {
			result.Findings = append(result.Findings, Finding{Severity: "blocked", Code: "incompatible_stream", Message: fmt.Sprintf("Stream %d (%s/%s) cannot be preserved in %s precise output; choose another stream or MKV.", index, stream.Type, stream.Codec, policy.Name), StreamIndex: &index})
		}
	}
	if len(request.StreamIndexes) == 0 {
		result.Selection = nil
		for _, stream := range metadata.Streams {
			if stream.Type == "video" || stream.Type == "audio" || stream.Type == "subtitle" {
				result.Selection = append(result.Selection, stream.Index)
				appendCompatibility(stream.Index, stream)
			}
		}
		result.Findings = append(result.Findings, Finding{Severity: "allowed", Code: "default_stream_selection", Message: "Selected video, audio, and subtitle streams by default."})
	} else {
		seen := map[int]bool{}
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
			appendCompatibility(index, stream)
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
	if result.Allowed {
		policy, ok := exportpolicy.For(request.Container)
		if !ok {
			result.Allowed = false
			result.Findings = append(result.Findings, Finding{Severity: "blocked", Code: "unsupported_container", Message: "container must be MKV, MP4, or MOV"})
		} else if err := s.checkCapabilities(ctx, policy, request.CutStrategy); err != nil {
			if ctx.Err() != nil {
				return result, err
			}
			result.Allowed = false
			result.Findings = append(result.Findings, Finding{Severity: "blocked", Code: "capability_unavailable", Message: fmt.Sprintf("Required FFmpeg support for %s %s output is unavailable.", policy.Name, request.CutStrategy)})
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
