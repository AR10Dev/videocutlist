package httpapi

import (
	"context"
	"errors"
	"net"
	"net/http"
	"strings"
)

const (
	maxForwardedChain = 32
	maxForwardedBytes = 4 << 10
	maxForwardedHost  = 255
	maxForwardedUser  = 320
)

type forwardedInfoKey struct{}

// ForwardedInfo contains the validated request values selected at the proxy
// boundary. PeerIP is always the transport peer; ClientIP may be forwarded.
type ForwardedInfo struct {
	ClientIP net.IP
	PeerIP   net.IP
	Host     string
	Proto    string
	User     string
}

// GetForwardedInfo returns the values attached by TrustedProxy. It returns the
// zero value when called outside that middleware.
func GetForwardedInfo(ctx context.Context) ForwardedInfo {
	info, _ := ctx.Value(forwardedInfoKey{}).(ForwardedInfo)
	return info
}

// TrustedProxy accepts forwarded values only from configured transport peers.
// It always removes forwarding headers before passing a request downstream.
func TrustedProxy(trustedCIDRs []string, next http.Handler) (http.Handler, error) {
	trusted, err := parseTrustedCIDRs(trustedCIDRs)
	if err != nil {
		return nil, err
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		forwarded := takeForwardedHeaders(r.Header)
		peer, err := transportIP(r.RemoteAddr)
		if err != nil {
			http.Error(w, "invalid transport peer", http.StatusBadRequest)
			return
		}
		info := ForwardedInfo{
			ClientIP: peer,
			PeerIP:   peer,
			Host:     r.Host,
			Proto:    transportProto(r),
		}
		if containsIP(trusted, peer) {
			if info, err = parseForwardedInfo(info, forwarded, trusted); err != nil {
				http.Error(w, "invalid forwarded headers", http.StatusBadRequest)
				return
			}
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), forwardedInfoKey{}, info)))
	}), nil
}

type forwardedHeaders struct {
	forValues   []string
	hostValues  []string
	protoValues []string
	userValues  []string
}

func takeForwardedHeaders(headers http.Header) forwardedHeaders {
	var values forwardedHeaders
	for key, value := range headers {
		switch {
		case strings.EqualFold(key, "X-Forwarded-For"):
			values.forValues = append(values.forValues, value...)
		case strings.EqualFold(key, "X-Forwarded-Host"):
			values.hostValues = append(values.hostValues, value...)
		case strings.EqualFold(key, "X-Forwarded-Proto"):
			values.protoValues = append(values.protoValues, value...)
		case strings.EqualFold(key, "X-Forwarded-User"):
			values.userValues = append(values.userValues, value...)
		default:
			continue
		}
		delete(headers, key)
	}
	return values
}

func parseTrustedCIDRs(values []string) ([]*net.IPNet, error) {
	trusted := make([]*net.IPNet, 0, len(values))
	for _, value := range values {
		_, network, err := net.ParseCIDR(strings.TrimSpace(value))
		if err != nil {
			return nil, err
		}
		trusted = append(trusted, network)
	}
	return trusted, nil
}

func parseForwardedInfo(info ForwardedInfo, headers forwardedHeaders, trusted []*net.IPNet) (ForwardedInfo, error) {
	if len(headers.hostValues) > 1 || len(headers.protoValues) > 1 || len(headers.userValues) > 1 {
		return ForwardedInfo{}, errors.New("multiple forwarded values")
	}
	if len(headers.forValues) > 0 {
		client, err := forwardedClientIP(strings.Join(headers.forValues, ","), trusted)
		if err != nil {
			return ForwardedInfo{}, err
		}
		info.ClientIP = client
	}
	if len(headers.hostValues) == 1 {
		host, err := singleForwardedValue(headers.hostValues[0], maxForwardedHost)
		if err != nil {
			return ForwardedInfo{}, err
		}
		info.Host = host
	}
	if len(headers.protoValues) == 1 {
		proto, err := singleForwardedValue(headers.protoValues[0], len("https"))
		if err != nil || proto != "http" && proto != "https" {
			return ForwardedInfo{}, errors.New("invalid forwarded proto")
		}
		info.Proto = proto
	}
	if len(headers.userValues) == 1 {
		user, err := singleForwardedValue(headers.userValues[0], maxForwardedUser)
		if err != nil {
			return ForwardedInfo{}, err
		}
		info.User = user
	}
	return info, nil
}

func forwardedClientIP(value string, trusted []*net.IPNet) (net.IP, error) {
	if len(value) > maxForwardedBytes || hasControl(value) {
		return nil, errors.New("invalid forwarded chain")
	}
	parts := strings.Split(value, ",")
	if len(parts) == 0 || len(parts) > maxForwardedChain {
		return nil, errors.New("invalid forwarded chain")
	}
	ips := make([]net.IP, len(parts))
	for index, part := range parts {
		ip := net.ParseIP(strings.TrimSpace(part))
		if ip == nil {
			return nil, errors.New("invalid forwarded chain")
		}
		ips[index] = ip
	}
	for index := len(ips) - 1; index >= 0; index-- {
		if !containsIP(trusted, ips[index]) {
			return ips[index], nil
		}
	}
	return ips[0], nil
}

func singleForwardedValue(value string, max int) (string, error) {
	if value == "" || len(value) > max || strings.Contains(value, ",") || hasControl(value) {
		return "", errors.New("invalid forwarded value")
	}
	return value, nil
}

func transportIP(remoteAddr string) (net.IP, error) {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		return nil, err
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return nil, errors.New("invalid transport peer")
	}
	return ip, nil
}

func transportProto(request *http.Request) string {
	if request.TLS != nil {
		return "https"
	}
	return "http"
}

func containsIP(networks []*net.IPNet, ip net.IP) bool {
	for _, network := range networks {
		if network.Contains(ip) {
			return true
		}
	}
	return false
}

func hasControl(value string) bool {
	return strings.IndexFunc(value, func(r rune) bool { return r <= 31 || r == 127 }) >= 0
}
