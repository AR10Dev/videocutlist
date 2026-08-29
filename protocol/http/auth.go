package httpapi

import (
	"crypto/subtle"
	"errors"
	"net"
	"net/http"
	"strings"
	"unicode"
)

var ErrUnauthenticated = errors.New("unauthenticated")

// Authenticator is the deployment access gate; it never creates an application identity.
type Authenticator interface {
	Authenticate(*http.Request) error
}
type AuthConfig struct {
	Mode, BearerToken string
	ListenAddress     string
}
type authenticator struct {
	mode  string
	token []byte
}

func NewAuthenticator(config AuthConfig) (Authenticator, error) {
	mode := config.Mode
	if mode == "" {
		mode = "none"
	}
	if mode != "none" && mode != "bearer" && mode != "trusted_proxy" {
		return nil, errors.New("unsupported authentication mode")
	}
	if mode == "none" && config.ListenAddress != "" {
		ip := net.ParseIP(config.ListenAddress)
		if ip == nil || !ip.IsLoopback() {
			return nil, errors.New("authentication is required for non-loopback listeners")
		}
	}
	if mode == "bearer" && !validToken(config.BearerToken) {
		return nil, errors.New("invalid bearer configuration")
	}
	return &authenticator{mode: mode, token: []byte(config.BearerToken)}, nil
}
func (a *authenticator) Authenticate(r *http.Request) error {
	switch a.mode {
	case "none":
		return nil
	case "trusted_proxy":
		if !GetForwardedInfo(r.Context()).Trusted {
			return ErrUnauthenticated
		}
	case "bearer":
		values := r.Header.Values("Authorization")
		if len(values) != 1 {
			return ErrUnauthenticated
		}
		const prefix = "Bearer "
		value := values[0]
		if len(value) <= len(prefix) || !strings.EqualFold(value[:len(prefix)-1], prefix[:len(prefix)-1]) || value[len(prefix)-1] != ' ' || subtle.ConstantTimeCompare([]byte(value[len(prefix):]), a.token) != 1 {
			return ErrUnauthenticated
		}
	default:
		return ErrUnauthenticated
	}
	return nil
}
func validToken(value string) bool      { return value != "" && !containsControl(value) }
func containsControl(value string) bool { return strings.IndexFunc(value, unicode.IsControl) >= 0 }
