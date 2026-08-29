package httpapi

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestNoneAuthRejectsNonLoopbackListener(t *testing.T) {
	if _, err := NewAuthenticator(AuthConfig{Mode: "none", ListenAddress: "0.0.0.0"}); err == nil {
		t.Fatal("non-loopback listener accepted unauthenticated mode")
	}
	if _, err := NewAuthenticator(AuthConfig{Mode: "none", ListenAddress: "127.0.0.1"}); err != nil {
		t.Fatal(err)
	}
}

func TestAuthenticatorModes(t *testing.T) {
	none, _ := NewAuthenticator(AuthConfig{Mode: "none"})
	if err := none.Authenticate(httptest.NewRequest(http.MethodGet, "http://api.test", nil)); err != nil {
		t.Fatal(err)
	}
	bearer, err := NewAuthenticator(AuthConfig{Mode: "bearer", BearerToken: "alpha beta"})
	if err != nil {
		t.Fatal(err)
	}
	for name, authorization := range map[string][]string{"correct": {"Bearer alpha beta"}, "missing": nil, "wrong": {"Bearer alpha gamma"}, "bad scheme": {"Basic alpha beta"}, "multiple": {"Bearer alpha beta", "Bearer alpha beta"}} {
		t.Run(name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodGet, "http://api.test", nil)
			r.Header["Authorization"] = authorization
			err := bearer.Authenticate(r)
			if name == "correct" && err != nil {
				t.Fatal(err)
			}
			if name != "correct" && err == nil {
				t.Fatal("request was accepted")
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
	if err := authenticator.Authenticate(raw); err == nil {
		t.Fatal("raw forwarded user was accepted")
	}
	var authErr error
	handler, err := TrustedProxy([]string{"127.0.0.0/8"}, http.HandlerFunc(func(_ http.ResponseWriter, request *http.Request) { authErr = authenticator.Authenticate(request) }))
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest(http.MethodGet, "http://api.test", nil)
	r.RemoteAddr = "127.0.0.1:1234"
	r.Header.Set("X-Forwarded-User", "proxy-editor")
	handler.ServeHTTP(httptest.NewRecorder(), r)
	if authErr != nil {
		t.Fatal(authErr)
	}
}
