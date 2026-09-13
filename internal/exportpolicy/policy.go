// Package exportpolicy defines the supported output-container contract.
package exportpolicy

import (
	"path/filepath"
	"strings"
)

// Policy is the single source of truth for output naming, muxing, MIME, and
// conservative stream compatibility.
type Policy struct {
	Name      string
	Extension string
	Muxer     string
	MIME      string
	FastStart bool
	aliases   []string
}

var (
	mkvPolicy = Policy{
		Name:      "mkv",
		Extension: "mkv",
		Muxer:     "matroska",
		MIME:      "video/x-matroska",
		aliases:   []string{"matroska"},
	}
	mp4Policy = Policy{
		Name:      "mp4",
		Extension: "mp4",
		Muxer:     "mp4",
		MIME:      "video/mp4",
		FastStart: true,
		// FFprobe reports the MOV/MP4 family as a comma-separated alias list.
		aliases: []string{"mp4", "mov"},
	}
	movPolicy = Policy{
		Name:      "mov",
		Extension: "mov",
		Muxer:     "mov",
		MIME:      "video/quicktime",
		FastStart: true,
		// FFprobe reports the MOV/MP4 family as a comma-separated alias list.
		aliases: []string{"mp4", "mov"},
	}
)

// For resolves a user-facing container name. An empty name retains the MKV
// default for projects and requests created before container selection existed.
func For(name string) (Policy, bool) {
	switch strings.ToLower(name) {
	case "", "mkv":
		return mkvPolicy, true
	case "mp4":
		return mp4Policy, true
	case "mov":
		return movPolicy, true
	default:
		return Policy{}, false
	}
}

// ForFilename resolves a policy from a generated output filename.
func ForFilename(name string) (Policy, bool) {
	extension := strings.TrimPrefix(strings.ToLower(filepath.Ext(name)), ".")
	return For(extension)
}

// MIMEForOutputName returns the policy MIME for a generated output name.
// Unknown names intentionally use a download-safe generic type.
func MIMEForOutputName(name string) string {
	if policy, ok := ForFilename(name); ok {
		return policy.MIME
	}
	return "application/octet-stream"
}

// MatchesFormat accepts FFprobe's format aliases rather than requiring one
// exact format_name string.
func (p Policy) MatchesFormat(format string) bool {
	for token := range strings.SplitSeq(strings.ToLower(format), ",") {
		for _, alias := range p.aliases {
			if strings.TrimSpace(token) == alias {
				return true
			}
		}
	}
	return false
}

// SupportsStreamCopy reports the conservative stream-copy set for a policy.
func (p Policy) SupportsStreamCopy(streamType, codec string) bool {
	if p.Name == "mkv" {
		return streamType == "video" || streamType == "audio" || streamType == "subtitle"
	}
	switch streamType {
	case "video":
		return strings.EqualFold(codec, "h264")
	case "audio":
		return strings.EqualFold(codec, "aac")
	default:
		return false
	}
}

// SupportsPrecise reports streams supported by the existing software
// H.264/AAC path. Subtitle conversion is deliberately not implicit.
func (p Policy) SupportsPrecise(streamType string) bool {
	if p.Name == "mkv" {
		return streamType == "video" || streamType == "audio" || streamType == "subtitle"
	}
	return streamType == "video" || streamType == "audio"
}
