// Package auth provides provider-neutral request authentication.
package auth

import (
	"crypto/subtle"
	"errors"
	"net/http"
	"strings"
	"unicode"

	"editapp/internal/httpx"
)

var ErrUnauthenticated = errors.New("unauthenticated")

// Principal is the authenticated subject propagated through application code.
type Principal struct {
	Subject      string
	DisplayName  string
	Roles        []string
	Capabilities []string
}

// Allows reports whether a principal has a matching generic capability.
func (principal Principal) Allows(action, resource string) bool {
	for _, capability := range principal.Capabilities {
		if capability == "*" || capability == action || capability == action+":"+resource {
			return true
		}
	}
	return false
}

// Authenticator turns a request into a provider-neutral principal.
type Authenticator interface {
	Authenticate(*http.Request) (Principal, error)
}

type Config struct {
	Mode          string
	BearerToken   string
	BearerSubject string
}

type authenticator struct {
	mode      string
	token     []byte
	principal Principal
}

// New constructs one of the built-in generic authenticators.
func New(config Config) (Authenticator, error) {
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
	if mode == "bearer" {
		if !validToken(config.BearerToken) || !validSubject(subject) {
			return nil, errors.New("invalid bearer configuration")
		}
	}
	return &authenticator{
		mode:      mode,
		token:     []byte(config.BearerToken),
		principal: builtInPrincipal(subject),
	}, nil
}

func (authenticator *authenticator) Authenticate(request *http.Request) (Principal, error) {
	switch authenticator.mode {
	case "none":
		return builtInPrincipal("anonymous"), nil
	case "bearer":
		return authenticator.bearer(request)
	case "trusted_proxy":
		subject := httpx.GetForwardedInfo(request.Context()).User
		if !validSubject(subject) {
			return Principal{}, ErrUnauthenticated
		}
		return builtInPrincipal(subject), nil
	default:
		return Principal{}, ErrUnauthenticated
	}
}

func (authenticator *authenticator) bearer(request *http.Request) (Principal, error) {
	values := request.Header.Values("Authorization")
	if len(values) != 1 {
		return Principal{}, ErrUnauthenticated
	}
	const prefix = "Bearer "
	value := values[0]
	if len(value) <= len(prefix) || !strings.EqualFold(value[:len(prefix)-1], prefix[:len(prefix)-1]) || value[len(prefix)-1] != ' ' || subtle.ConstantTimeCompare([]byte(value[len(prefix):]), authenticator.token) != 1 {
		return Principal{}, ErrUnauthenticated
	}
	return authenticator.principal, nil
}

func builtInPrincipal(subject string) Principal {
	return Principal{Subject: subject, Roles: []string{"editor"}, Capabilities: []string{"*"}}
}

func validToken(token string) bool {
	return token != "" && !containsControl(token)
}

func validSubject(subject string) bool {
	return subject != "" && subject == strings.TrimSpace(subject) && len(subject) <= 320 && !containsControl(subject)
}

func containsControl(value string) bool {
	return strings.IndexFunc(value, unicode.IsControl) >= 0
}
