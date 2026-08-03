package httpapi

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"videocutlist/domain"
)

func TestPrincipalAllows(t *testing.T) {
	principal := domain.Principal{Capabilities: []string{"preview", "export:p_allowed"}}
	if !principal.Allows("preview", "m_any") || !principal.Allows("export", "p_allowed") {
		t.Fatal("matching capability was rejected")
	}
	if principal.Allows("export", "p_denied") || principal.Allows("refresh", "*") {
		t.Fatal("non-matching capability was accepted")
	}
	if !(domain.Principal{Capabilities: []string{"*"}}).Allows("anything", "anywhere") {
		t.Fatal("wildcard capability was rejected")
	}
}

func TestBuiltinAuthenticatorModes(t *testing.T) {
	none, err := NewAuthenticator(AuthConfig{Mode: "none"})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodGet, "http://api.test", nil)
	request.Header.Set("Authorization", "Bearer ignored")
	principal, err := none.Authenticate(request)
	if err != nil || principal.Subject != "anonymous" || !principal.Allows("preview", "m_any") {
		t.Fatalf("none principal = %#v, err = %v", principal, err)
	}

	bearer, err := NewAuthenticator(AuthConfig{Mode: "bearer", BearerToken: "alpha beta"})
	if err != nil {
		t.Fatal(err)
	}
	for name, authorization := range map[string][]string{
		"correct internal space": {"Bearer alpha beta"},
		"missing":                nil,
		"missing suffix":         {"Bearer"},
		"wrong":                  {"Bearer alpha gamma"},
		"bad scheme":             {"Basic alpha beta"},
		"multiple":               {"Bearer alpha beta", "Bearer alpha beta"},
	} {
		t.Run(name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, "http://api.test", nil)
			request.Header["Authorization"] = authorization
			principal, err := bearer.Authenticate(request)
			if name == "correct internal space" {
				if err != nil || principal.Subject != "static-bearer" || !principal.Allows("export", "p_any") {
					t.Fatalf("principal = %#v, err = %v", principal, err)
				}
				return
			}
			if err == nil {
				t.Fatalf("principal = %#v, want rejection", principal)
			}
		})
	}
}

func TestTrustedProxyAuthenticatorUsesOnlyContext(t *testing.T) {
	authenticator, err := NewAuthenticator(AuthConfig{Mode: "trusted_proxy"})
	if err != nil {
		t.Fatal(err)
	}
	raw := httptest.NewRequest(http.MethodGet, "http://api.test", nil)
	raw.Header.Set("X-Forwarded-User", "spoofed")
	if _, err := authenticator.Authenticate(raw); err == nil {
		t.Fatal("raw forwarded user was accepted")
	}

	var principal domain.Principal
	handler, err := TrustedProxy([]string{"127.0.0.0/8"}, http.HandlerFunc(func(_ http.ResponseWriter, request *http.Request) {
		principal, err = authenticator.Authenticate(request)
	}))
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodGet, "http://api.test", nil)
	request.RemoteAddr = "127.0.0.1:1234"
	request.Header.Set("X-Forwarded-User", "proxy-editor")
	handler.ServeHTTP(httptest.NewRecorder(), request)
	if err != nil || principal.Subject != "proxy-editor" || !principal.Allows("preview", "m_any") {
		t.Fatalf("principal = %#v, err = %v", principal, err)
	}
}
