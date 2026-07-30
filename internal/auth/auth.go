// Package auth authenticates only the Tailscale Serve proxy boundary.
package auth

import (
	"encoding/json"
	"errors"
	"mime"
	"net"
	"net/http"
	"strings"
)

const (
	loginHeader = "Tailscale-User-Login"
	capsHeader  = "Tailscale-App-Capabilities"
	maxCapsSize = 8 << 10
)

var ErrUnauthenticated = errors.New("unauthenticated")

type Identity struct {
	Login        string
	Capabilities Capabilities
}

// Capabilities is Tailscale's map of opaque capability names to grant objects.
type Capabilities map[string][]json.RawMessage

// Allows implements the common action/resources grant shape. An absent
// capability never authorizes; callers choose the capability name and action.
func (c Capabilities) Allows(name, action, resource string) bool {
	for _, raw := range c[name] {
		var grant struct {
			Action    []string `json:"action"`
			Resources []string `json:"resources"`
		}
		if json.Unmarshal(raw, &grant) == nil && matches(grant.Action, action) && matches(grant.Resources, resource) {
			return true
		}
	}
	return false
}

func (c Capabilities) AllowsAny(action, resource string) bool {
	for name := range c {
		if c.Allows(name, action, resource) {
			return true
		}
	}
	return false
}

func matches(values []string, want string) bool {
	for _, value := range values {
		if value == "*" || value == want {
			return true
		}
	}
	return false
}

type Config struct {
	Mode              string
	DevUserLogin      string
	TrustedProxyCIDRs []string
}

type Authenticator struct {
	mode     string
	devLogin string
	trusted  []*net.IPNet
}

func New(config Config) (*Authenticator, error) {
	a := &Authenticator{mode: config.Mode, devLogin: normalize(config.DevUserLogin)}
	if a.mode == "" {
		a.mode = "tailscale"
	}
	if a.mode != "tailscale" && a.mode != "dev" {
		return nil, errors.New("unsupported authentication mode")
	}
	if a.mode == "dev" && a.devLogin == "" {
		return nil, errors.New("development user login is required")
	}
	for _, cidr := range config.TrustedProxyCIDRs {
		_, network, err := net.ParseCIDR(strings.TrimSpace(cidr))
		if err != nil {
			return nil, err
		}
		a.trusted = append(a.trusted, network)
	}
	if a.mode == "tailscale" && len(a.trusted) == 0 {
		return nil, errors.New("trusted proxy CIDRs are required")
	}
	return a, nil
}

func (a *Authenticator) Authenticate(request *http.Request) (Identity, error) {
	ip, err := remoteIP(request.RemoteAddr)
	if err != nil || !ip.IsLoopback() && a.mode == "dev" {
		return Identity{}, ErrUnauthenticated
	}
	if a.mode == "dev" {
		return Identity{Login: a.devLogin}, nil // Never consume spoofable identity headers in dev mode.
	}
	if !a.isTrusted(ip) {
		return Identity{}, ErrUnauthenticated
	}
	login := normalize(decodeHeader(request.Header.Get(loginHeader)))
	if login == "" {
		return Identity{}, ErrUnauthenticated
	}
	caps, err := parseCapabilities(request.Header.Get(capsHeader))
	if err != nil {
		return Identity{}, ErrUnauthenticated
	}
	return Identity{Login: login, Capabilities: caps}, nil
}

func (a *Authenticator) isTrusted(ip net.IP) bool {
	for _, network := range a.trusted {
		if network.Contains(ip) {
			return true
		}
	}
	return false
}

func remoteIP(remote string) (net.IP, error) {
	host, _, err := net.SplitHostPort(remote)
	if err != nil {
		return nil, err
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return nil, errors.New("invalid remote address")
	}
	return ip, nil
}

func parseCapabilities(value string) (Capabilities, error) {
	if value == "" {
		return Capabilities{}, nil
	}
	if len(value) > maxCapsSize {
		return nil, errors.New("capabilities header is too large")
	}
	decoded := decodeHeader(value)
	var capabilities Capabilities
	if err := json.Unmarshal([]byte(decoded), &capabilities); err != nil || capabilities == nil {
		return nil, errors.New("invalid capabilities header")
	}
	return capabilities, nil
}

func decodeHeader(value string) string {
	decoded, err := new(mime.WordDecoder).DecodeHeader(value)
	if err == nil {
		return decoded
	}
	return value
}

func normalize(login string) string {
	login = strings.ToLower(strings.TrimSpace(login))
	if len(login) > 320 || strings.ContainsAny(login, "\r\n\x00") {
		return ""
	}
	return login
}
