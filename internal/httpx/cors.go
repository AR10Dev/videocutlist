package httpx

import (
	"net/http"
	"net/url"
	"strings"
)

const (
	allowedMethods   = "GET, HEAD, POST, PUT, DELETE"
	allowedHeaders   = "Authorization, Content-Type, If-Match, If-None-Match"
	exposedHeaders   = "ETag, X-Request-ID, X-Preview-Start, X-Preview-Duration, X-Preview-Offset, X-Preview-Cache, Retry-After"
	allowCredentials = "true"
)

// CORS permits only configured exact origins. It handles valid preflights
// without reaching downstream authentication or application handlers.
func CORS(allowedOrigins []string, next http.Handler) http.Handler {
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
			writer.WriteHeader(http.StatusForbidden)
			return
		}
		if _, ok := allowed[origin]; !ok {
			writer.WriteHeader(http.StatusForbidden)
			return
		}

		if request.Method == http.MethodOptions || len(request.Header.Values("Access-Control-Request-Method")) != 0 || len(request.Header.Values("Access-Control-Request-Headers")) != 0 {
			if !validPreflight(request) {
				writer.WriteHeader(http.StatusForbidden)
				return
			}
			setCORSHeaders(writer.Header(), origin)
			addVary(writer.Header(), "Access-Control-Request-Method")
			addVary(writer.Header(), "Access-Control-Request-Headers")
			writer.Header().Set("Access-Control-Allow-Methods", allowedMethods)
			writer.Header().Set("Access-Control-Allow-Headers", allowedHeaders)
			writer.WriteHeader(http.StatusNoContent)
			return
		}

		setCORSHeaders(writer.Header(), origin)
		writer.Header().Set("Access-Control-Expose-Headers", exposedHeaders)
		next.ServeHTTP(writer, request)
	})
}

func setCORSHeaders(header http.Header, origin string) {
	header.Set("Access-Control-Allow-Origin", origin)
	header.Set("Access-Control-Allow-Credentials", allowCredentials)
	addVary(header, "Origin")
}

func validOrigin(origin string) bool {
	parsed, err := url.Parse(origin)
	return err == nil && (parsed.Scheme == "http" || parsed.Scheme == "https") && parsed.Hostname() != "" && parsed.User == nil && parsed.Path == "" && parsed.RawQuery == "" && !parsed.ForceQuery && parsed.Fragment == "" && parsed.Opaque == ""
}

func validPreflight(request *http.Request) bool {
	methods := request.Header.Values("Access-Control-Request-Method")
	if request.Method != http.MethodOptions || len(methods) != 1 || !validMethod(methods[0]) {
		return false
	}
	for _, values := range request.Header.Values("Access-Control-Request-Headers") {
		for _, header := range strings.Split(values, ",") {
			if !validHeader(strings.TrimSpace(header)) {
				return false
			}
		}
	}
	return true
}

func validMethod(method string) bool {
	for _, allowed := range strings.Split(allowedMethods, ", ") {
		if strings.EqualFold(strings.TrimSpace(method), allowed) {
			return true
		}
	}
	return false
}

func validHeader(header string) bool {
	if header == "" {
		return false
	}
	for _, allowed := range strings.Split(allowedHeaders, ", ") {
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
