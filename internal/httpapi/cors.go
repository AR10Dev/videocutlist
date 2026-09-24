package httpapi

import (
	"net/http"
	"net/url"
	"strings"
)

const (
	restAllowedMethods = "GET, HEAD, POST, PUT, DELETE"
	restAllowedHeaders = "Authorization, Content-Type, If-Match, If-None-Match"
	restExposedHeaders = "ETag, X-Request-ID, X-Preview-Start, X-Preview-Duration, X-Preview-Offset, X-Preview-Cache, Retry-After"
	mcpAllowedMethods  = "GET, POST, DELETE"
	mcpAllowedHeaders  = "Authorization, Content-Type, MCP-Protocol-Version, Mcp-Session-Id"
	mcpExposedHeaders  = "Mcp-Session-Id"
	allowCredentials   = "true"
)

type corsPolicy struct {
	allowedMethods string
	allowedHeaders string
	exposedHeaders string
}

var restCORSPolicy = corsPolicy{
	allowedMethods: restAllowedMethods,
	allowedHeaders: restAllowedHeaders,
	exposedHeaders: restExposedHeaders,
}

var mcpCORSPolicy = corsPolicy{
	allowedMethods: mcpAllowedMethods,
	allowedHeaders: mcpAllowedHeaders,
	exposedHeaders: mcpExposedHeaders,
}

// CORS permits only configured exact origins. It handles valid preflights
// without reaching downstream authentication or application handlers.
func CORS(allowedOrigins []string, next http.Handler) http.Handler {
	return cors(allowedOrigins, next, restCORSPolicy)
}

// MCPCORS applies the MCP Streamable HTTP CORS policy. MCP clients need
// protocol and session headers that are deliberately not accepted by REST.
func MCPCORS(allowedOrigins []string, next http.Handler) http.Handler {
	return cors(allowedOrigins, next, mcpCORSPolicy)
}

func cors(allowedOrigins []string, next http.Handler, policy corsPolicy) http.Handler {
	allowed := make(map[string]struct{}, len(allowedOrigins))
	for _, origin := range allowedOrigins {
		allowed[origin] = struct{}{}
	}
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		origins := request.Header.Values("Origin")
		if len(origins) == 0 {
			next.ServeHTTP(writer, request)
			return
		}
		origin := origins[0]
		if len(origins) != 1 || !validOrigin(origin) {
			rejectOrigin(writer, request)
			return
		}
		if _, ok := allowed[origin]; !ok && !sameOrigin(request, origin) {
			rejectOrigin(writer, request)
			return
		}

		if request.Method == http.MethodOptions || len(request.Header.Values("Access-Control-Request-Method")) != 0 || len(request.Header.Values("Access-Control-Request-Headers")) != 0 {
			if !validPreflight(request, policy) {
				rejectOrigin(writer, request)
				return
			}
			setCORSHeaders(writer.Header(), origin)
			addVary(writer.Header(), "Access-Control-Request-Method")
			addVary(writer.Header(), "Access-Control-Request-Headers")
			writer.Header().Set("Access-Control-Allow-Methods", policy.allowedMethods)
			writer.Header().Set("Access-Control-Allow-Headers", policy.allowedHeaders)
			writer.WriteHeader(http.StatusNoContent)
			return
		}

		setCORSHeaders(writer.Header(), origin)
		if policy.exposedHeaders != "" {
			writer.Header().Set("Access-Control-Expose-Headers", policy.exposedHeaders)
		}
		next.ServeHTTP(writer, request)
	})
}

func rejectOrigin(w http.ResponseWriter, r *http.Request) {
	if strings.HasPrefix(r.URL.Path, "/api/") {
		id := w.Header().Get("X-Request-ID")
		if id == "" {
			id = RequestID()
			w.Header().Set("X-Request-ID", id)
		}
		Error(w, http.StatusForbidden, "origin_forbidden", "Request origin is not allowed.", id)
		return
	}
	// MCP retains its transport protocol; it never receives a REST envelope.
	w.WriteHeader(http.StatusForbidden)
}

func setCORSHeaders(header http.Header, origin string) {
	header.Set("Access-Control-Allow-Origin", origin)
	header.Set("Access-Control-Allow-Credentials", allowCredentials)
	addVary(header, "Origin")
}

func validOrigin(origin string) bool {
	parsed, err := url.Parse(origin)
	return err == nil && (parsed.Scheme == "http" || parsed.Scheme == "https") &&
		parsed.Hostname() != "" && parsed.User == nil && parsed.Path == "" &&
		parsed.RawQuery == "" && !parsed.ForceQuery && parsed.Fragment == "" && parsed.Opaque == ""
}

func sameOrigin(request *http.Request, origin string) bool {
	parsed, err := url.Parse(origin)
	if err != nil || parsed.Host == "" {
		return false
	}
	host, scheme := request.Host, "http"
	if request.TLS != nil {
		scheme = "https"
	}
	forwarded := GetForwardedInfo(request.Context())
	if forwarded.Trusted {
		host, scheme = forwarded.Host, forwarded.Proto
	}
	if host == "" || (scheme != "http" && scheme != "https") {
		return false
	}
	return strings.EqualFold(parsed.Host, host) && parsed.Scheme == scheme
}

func validPreflight(request *http.Request, policy corsPolicy) bool {
	methods := request.Header.Values("Access-Control-Request-Method")
	if request.Method != http.MethodOptions || len(methods) != 1 || !validMethod(methods[0], policy.allowedMethods) {
		return false
	}
	for _, values := range request.Header.Values("Access-Control-Request-Headers") {
		for _, header := range strings.Split(values, ",") {
			if !validHeader(strings.TrimSpace(header), policy.allowedHeaders) {
				return false
			}
		}
	}
	return true
}

func validMethod(method, allowedMethods string) bool {
	for allowed := range strings.SplitSeq(allowedMethods, ", ") {
		if strings.EqualFold(strings.TrimSpace(method), allowed) {
			return true
		}
	}
	return false
}

func validHeader(header, allowedHeaders string) bool {
	if header == "" {
		return false
	}
	for allowed := range strings.SplitSeq(allowedHeaders, ", ") {
		if strings.EqualFold(header, allowed) {
			return true
		}
	}
	return false
}

func addVary(header http.Header, value string) {
	for _, existing := range header.Values("Vary") {
		for _, item := range strings.Split(existing, ",") {
			if strings.EqualFold(strings.TrimSpace(item), value) {
				return
			}
		}
	}
	header.Add("Vary", value)
}
