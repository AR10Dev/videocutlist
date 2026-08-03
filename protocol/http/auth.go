package httpapi

import (
	"crypto/subtle"
	"errors"
	"net/http"
	"strings"
	"unicode"

	"videocutlist/domain"
)

var ErrUnauthenticated = errors.New("unauthenticated")

// Authenticator remains HTTP-shaped so OIDC can be added behind this seam.
type Authenticator interface {
	Authenticate(*http.Request) (domain.Principal, error)
}
type AuthConfig struct{ Mode, BearerToken, BearerSubject string }
type authenticator struct {
	mode      string
	token     []byte
	principal domain.Principal
}

func NewAuthenticator(config AuthConfig) (Authenticator, error) {
	mode := config.Mode
	if mode == "" {
		mode = "none"
	}
	subject := config.BearerSubject
	if subject == "" {
		subject = "static-bearer"
	}
	if mode != "none" && mode != "bearer" && mode != "trusted_proxy" {
		return nil, errors.New("unsupported authentication mode")
	}
	if mode == "bearer" && (!validToken(config.BearerToken) || !validSubject(subject)) {
		return nil, errors.New("invalid bearer configuration")
	}
	return &authenticator{mode: mode, token: []byte(config.BearerToken), principal: builtInPrincipal(subject)}, nil
}
func (a *authenticator) Authenticate(r *http.Request) (domain.Principal, error) {
	switch a.mode {
	case "none":
		return builtInPrincipal("anonymous"), nil
	case "trusted_proxy":
		subject := GetForwardedInfo(r.Context()).User
		if !validSubject(subject) {
			return domain.Principal{}, ErrUnauthenticated
		}
		return builtInPrincipal(subject), nil
	case "bearer":
		values := r.Header.Values("Authorization")
		if len(values) != 1 {
			return domain.Principal{}, ErrUnauthenticated
		}
		const prefix = "Bearer "
		value := values[0]
		if len(value) <= len(prefix) || !strings.EqualFold(value[:len(prefix)-1], prefix[:len(prefix)-1]) || value[len(prefix)-1] != ' ' || subtle.ConstantTimeCompare([]byte(value[len(prefix):]), a.token) != 1 {
			return domain.Principal{}, ErrUnauthenticated
		}
		return a.principal, nil
	}
	return domain.Principal{}, ErrUnauthenticated
}
func builtInPrincipal(subject string) domain.Principal {
	return domain.Principal{Subject: subject, Roles: []string{"editor"}, Capabilities: []string{"*"}}
}
func validToken(value string) bool { return value != "" && !containsControl(value) }
func validSubject(value string) bool {
	return value != "" && value == strings.TrimSpace(value) && len(value) <= 320 && !containsControl(value)
}
func containsControl(value string) bool { return strings.IndexFunc(value, unicode.IsControl) >= 0 }
