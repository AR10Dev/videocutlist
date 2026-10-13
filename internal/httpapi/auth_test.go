package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
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
	bearer, err := NewAuthenticator(AuthConfig{Mode: "bearer", BearerToken: "alpha beta deployment test token 0123456789"})
	if err != nil {
		t.Fatal(err)
	}
	for name, authorization := range map[string][]string{"correct": {"Bearer alpha beta deployment test token 0123456789"}, "missing": nil, "wrong": {"Bearer alpha gamma deployment test token 0123456789"}, "bad scheme": {"Basic alpha beta deployment test token 0123456789"}, "multiple": {"Bearer alpha beta deployment test token 0123456789", "Bearer alpha beta deployment test token 0123456789"}} {
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

func TestAuthenticatorRejectsWeakBearerTokens(t *testing.T) {
	for _, test := range []struct {
		name    string
		token   string
		wantErr bool
	}{
		{"empty", "", true},
		{"short", strings.Repeat("x", 31), true},
		{"boundary", strings.Repeat("x", 32), false},
		{"long", strings.Repeat("x", 33), false},
		{"control", strings.Repeat("x", 32) + "\n", true},
	} {
		t.Run(test.name, func(t *testing.T) {
			_, err := NewAuthenticator(AuthConfig{Mode: "bearer", BearerToken: test.token})
			if (err != nil) != test.wantErr {
				t.Fatalf("configuration error = %v, want error %v", err, test.wantErr)
			}
			if err != nil && test.token != "" && strings.Contains(err.Error(), test.token) {
				t.Fatal("configuration error exposes token")
			}
		})
	}
}

func TestTrustedProxyAuthenticatorRequiresExplicitCIDRs(t *testing.T) {
	authenticator, err := NewAuthenticator(AuthConfig{Mode: "trusted_proxy"})
	if err == nil || authenticator != nil {
		t.Fatal("trusted-proxy authentication accepted an implicit trust boundary")
	}
}

func TestTrustedProxyAuthenticatorRejectsUniversalCIDRs(t *testing.T) {
	for _, cidr := range []string{"0.0.0.0/0", "::/0"} {
		t.Run(cidr, func(t *testing.T) {
			authenticator, err := NewAuthenticator(AuthConfig{Mode: "trusted_proxy", TrustedProxyCIDRs: []string{cidr}})
			if err == nil || authenticator != nil {
				t.Fatalf("trusted-proxy authentication accepted universal CIDR %q", cidr)
			}
		})
	}
}

func TestTrustedProxyAuthenticatorUsesOnlyContext(t *testing.T) {
	trustedCIDRs := []string{"127.0.0.0/8"}
	authenticator, err := NewAuthenticator(AuthConfig{Mode: "trusted_proxy", TrustedProxyCIDRs: trustedCIDRs})
	if err != nil {
		t.Fatal(err)
	}
	raw := httptest.NewRequest(http.MethodGet, "http://api.test", nil)
	raw.Header.Set("X-Forwarded-User", "spoofed")
	if err := authenticator.Authenticate(raw); err == nil {
		t.Fatal("raw forwarded user was accepted")
	}
	var authErr error
	called := false
	handler, err := TrustedProxy(trustedCIDRs, http.HandlerFunc(func(_ http.ResponseWriter, request *http.Request) {
		called = true
		authErr = authenticator.Authenticate(request)
	}))
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest(http.MethodGet, "http://api.test", nil)
	r.RemoteAddr = "127.0.0.1:1234"
	r.Header.Set("X-Forwarded-User", "proxy-editor")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, r)
	if !called || response.Code != http.StatusOK {
		t.Fatalf("trusted request was not accepted: called=%v status=%d", called, response.Code)
	}
	if authErr != nil {
		t.Fatal(authErr)
	}
}
