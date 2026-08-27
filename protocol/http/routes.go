package httpapi

import (
	"net/http"
	"net/url"
	"regexp"
	"strings"
)

var (
	mediaIDPattern   = regexp.MustCompile(`^m_[A-Za-z0-9_-]{43}$`)
	projectIDPattern = regexp.MustCompile(`^p_[A-Za-z0-9_-]{12,64}$`)
	jobIDPattern     = regexp.MustCompile(`^j_[A-Za-z0-9_-]{12,64}$`)
)

type routeKind uint8

const (
	routeUnknown routeKind = iota
	routeListMedia
	routeMediaStatus
	routeRefreshMedia
	routeStartMediaImport
	routeGetMediaImport
	routeCancelMediaImport
	routeGetMedia
	routePreview
	routeThumbnails
	routeWaveform
	routeGetProject
	routePutProject
	routeCreateExport
	routePreflightExport
	routeImportInterchange
	routeExportInterchange
	routeCreateDetection
	routeGetJob
	routeCancelJob
	routeAutomation
	routeListDestinations
	routeDownloadOutput
)

type route struct {
	kind routeKind
	id   string
}

func validMediaID(value string) bool   { return mediaIDPattern.MatchString(value) }
func validProjectID(value string) bool { return projectIDPattern.MatchString(value) }
func validJobID(value string) bool     { return jobIDPattern.MatchString(value) }

func parseRoute(method, path string) route {
	if !strings.HasPrefix(path, "/api/v1/") || strings.Contains(path, "\\") {
		return route{}
	}
	parts := strings.Split(strings.TrimPrefix(path, "/api/v1/"), "/")
	for i := range parts {
		decoded, err := url.PathUnescape(parts[i])
		if err != nil || decoded == "" || decoded != parts[i] && strings.Contains(decoded, "/") {
			return route{}
		}
		parts[i] = decoded
	}
	switch {
	case len(parts) == 1 && parts[0] == "media" && method == http.MethodGet:
		return route{kind: routeListMedia}
	case len(parts) == 2 && parts[0] == "media" && parts[1] == "status" && method == http.MethodGet:
		return route{kind: routeMediaStatus}
	case len(parts) == 1 && parts[0] == "destinations" && method == http.MethodGet:
		return route{kind: routeListDestinations}
	case len(parts) == 2 && parts[0] == "media" && parts[1] == "refresh" && method == http.MethodPost:
		return route{kind: routeRefreshMedia}
	case len(parts) == 2 && parts[0] == "media" && parts[1] == "import" && method == http.MethodPost:
		return route{kind: routeStartMediaImport}
	case len(parts) == 3 && parts[0] == "media" && parts[1] == "import" && validJobID(parts[2]) && method == http.MethodGet:
		return route{kind: routeGetMediaImport, id: parts[2]}
	case len(parts) == 3 && parts[0] == "media" && parts[1] == "import" && validJobID(parts[2]) && method == http.MethodDelete:
		return route{kind: routeCancelMediaImport, id: parts[2]}
	case len(parts) == 2 && parts[0] == "media" && validMediaID(parts[1]) && method == http.MethodGet:
		return route{kind: routeGetMedia, id: parts[1]}
	case len(parts) == 3 && parts[0] == "media" && validMediaID(parts[1]) && parts[2] == "preview" && (method == http.MethodGet || method == http.MethodHead):
		return route{kind: routePreview, id: parts[1]}
	case len(parts) == 3 && parts[0] == "media" && validMediaID(parts[1]) && parts[2] == "thumbnails" && method == http.MethodGet:
		return route{kind: routeThumbnails, id: parts[1]}
	case len(parts) == 3 && parts[0] == "media" && validMediaID(parts[1]) && parts[2] == "waveform" && method == http.MethodGet:
		return route{kind: routeWaveform, id: parts[1]}
	case len(parts) == 2 && parts[0] == "projects" && validProjectID(parts[1]) && method == http.MethodGet:
		return route{kind: routeGetProject, id: parts[1]}
	case len(parts) == 2 && parts[0] == "projects" && validProjectID(parts[1]) && method == http.MethodPut:
		return route{kind: routePutProject, id: parts[1]}
	case len(parts) == 4 && parts[0] == "projects" && validProjectID(parts[1]) && parts[2] == "exports" && parts[3] == "preflight" && method == http.MethodPost:
		return route{kind: routePreflightExport, id: parts[1]}
	case len(parts) == 3 && parts[0] == "projects" && validProjectID(parts[1]) && parts[2] == "exports" && method == http.MethodPost:
		return route{kind: routeCreateExport, id: parts[1]}
	case len(parts) == 4 && parts[0] == "projects" && validProjectID(parts[1]) && parts[2] == "interchange" && (parts[3] == "csv" || parts[3] == "chapters") && method == http.MethodPost:
		return route{kind: routeImportInterchange, id: parts[1] + ":" + parts[3]}
	case len(parts) == 4 && parts[0] == "projects" && validProjectID(parts[1]) && parts[2] == "interchange" && (parts[3] == "csv" || parts[3] == "chapters") && method == http.MethodGet:
		return route{kind: routeExportInterchange, id: parts[1] + ":" + parts[3]}
	case len(parts) == 3 && parts[0] == "projects" && validProjectID(parts[1]) && parts[2] == "detections" && method == http.MethodPost:
		return route{kind: routeCreateDetection, id: parts[1]}
	case len(parts) == 2 && parts[0] == "jobs" && validJobID(parts[1]) && method == http.MethodGet:
		return route{kind: routeGetJob, id: parts[1]}
	case len(parts) == 4 && parts[0] == "jobs" && validJobID(parts[1]) && parts[2] == "outputs" && method == http.MethodGet:
		return route{kind: routeDownloadOutput, id: parts[1] + ":" + parts[3]}
	case len(parts) == 2 && parts[0] == "jobs" && validJobID(parts[1]) && method == http.MethodDelete:
		return route{kind: routeCancelJob, id: parts[1]}
	case len(parts) == 1 && parts[0] == "automation" && method == http.MethodPost:
		return route{kind: routeAutomation}
	default:
		return route{}
	}
}
