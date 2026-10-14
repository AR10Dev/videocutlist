package httpapi

import (
	"net/http"
	"net/url"
	"regexp"
	"strings"
)

var (
	mediaIDPattern      = regexp.MustCompile(`^m_[A-Za-z0-9_-]{43}$`)
	folderIDPattern     = regexp.MustCompile(`^f_[A-Za-z0-9_-]{43}$`)
	projectIDPattern    = regexp.MustCompile(`^p_[A-Za-z0-9_-]{12,64}$`)
	jobIDPattern        = regexp.MustCompile(`^j_[A-Za-z0-9_-]{12,64}$`)
	batchIDPattern      = regexp.MustCompile(`^b_[A-Za-z0-9_-]{12,64}$`)
	credentialIDPattern = regexp.MustCompile(`^c_[A-Za-z0-9_-]{12,64}$`)
	proposalIDPattern   = regexp.MustCompile(`^ep_[A-Za-z0-9_-]{12,64}$`)
)

type routeKind uint8

const (
	routeUnknown routeKind = iota
	routeListMedia
	routeBrowseMedia
	routeMediaStatus
	routeRefreshMedia
	routeStartMediaImport
	routeGetMediaImport
	routeCancelMediaImport
	routeGetMedia
	routeExportCapabilities
	routePreview
	routeThumbnails
	routeWaveform
	routeListProjects
	routeGetProject
	routePutProject
	routeCreateExport
	routePreflightExport
	routeImportInterchange
	routeExportInterchange
	routeCreateDetection
	routeGetJob
	routeStreamJob
	routeCancelJob
	routeAutomation
	routeListDestinations
	routeGetSettings
	routePutSettings
	routeRefreshSettings
	routeDownloadOutput
	routeDownloadBatch
	routeListBatches
	routeGetBatch
	routeCancelBatch
	routeRetryJob
	routeGetExportProposal
	routeApproveExportProposal
	routeGetMCPSettings
	routeCreateMCPCredential
	routeRevokeMCPCredential
	routeStreamBatch
	routeImportProjectFile
)

type route struct {
	kind routeKind
	id   string
}

// RouteCoverageKinds exposes the production inventory for black-box tests.
func RouteCoverageKinds() []string {
	return []string{
		"list_media", "browse_media", "media_status", "refresh_media", "start_media_import",
		"get_media_import", "cancel_media_import", "get_media", "export_capabilities", "preview", "thumbnails", "waveform",
		"list_projects", "get_project", "put_project", "create_export", "preflight_export",
		"import_interchange", "export_interchange", "create_detection", "get_job", "stream_job", "cancel_job",
		"automation", "list_destinations", "get_settings", "put_settings", "refresh_settings",
		"download_output", "download_batch", "list_batches", "get_batch", "cancel_batch", "retry_job",
		"get_export_proposal", "approve_export_proposal", "get_mcp_settings", "create_mcp_credential", "revoke_mcp_credential", "stream_batch", "import_project_file",
	}
}
func RouteCoverageKind(method, path string) string {
	r := parseRoute(method, path)
	kinds := RouteCoverageKinds()
	if r.kind == routeUnknown || int(r.kind)-1 >= len(kinds) {
		return ""
	}
	return kinds[r.kind-1]
}
func validMediaID(value string) bool      { return mediaIDPattern.MatchString(value) }
func validFolderID(value string) bool     { return folderIDPattern.MatchString(value) }
func validProjectID(value string) bool    { return projectIDPattern.MatchString(value) }
func validJobID(value string) bool        { return jobIDPattern.MatchString(value) }
func validBatchID(value string) bool      { return batchIDPattern.MatchString(value) }
func validCredentialID(value string) bool { return credentialIDPattern.MatchString(value) }
func validProposalID(value string) bool   { return proposalIDPattern.MatchString(value) }

// Reject paths ServeMux would otherwise clean or redirect, and encoded separators.
func validRoutePath(path string) bool {
	if !strings.HasPrefix(path, "/api/v2/") && !strings.HasPrefix(path, "/media/v2/") {
		return false
	}
	for part := range strings.SplitSeq(strings.TrimPrefix(path, "/"), "/") {
		decoded, err := url.PathUnescape(part)
		if err != nil || decoded == "" || decoded == "." || decoded == ".." || strings.ContainsAny(decoded, "/\\") {
			return false
		}
	}
	return true
}

var coverageMux = newRouteMux(nil)

// parseRoute is a coverage helper, not the production dispatcher. It asks the
// same ServeMux for its pattern and validates the corresponding wildcard values.
func parseRoute(method, path string) route {
	if !validRoutePath(path) {
		return route{}
	}
	u, err := url.ParseRequestURI(path)
	if err != nil {
		return route{}
	}
	r := &http.Request{Method: method, URL: u}
	_, pattern := coverageMux.Handler(r)
	for _, definition := range routeDefinitions {
		if definition.pattern != pattern || method == http.MethodHead && definition.kind != routePreview {
			continue
		}
		_, template, _ := strings.Cut(pattern, " ")
		parts := strings.Split(u.EscapedPath(), "/")
		for i, part := range strings.Split(template, "/") {
			if strings.HasPrefix(part, "{") {
				value, err := url.PathUnescape(parts[i])
				if err != nil {
					return route{}
				}
				r.SetPathValue(strings.Trim(part, "{}"), value)
			}
		}
		id, valid := routeResource(r)
		if !valid {
			return route{}
		}
		return route{kind: definition.kind, id: id}
	}
	return route{}
}
