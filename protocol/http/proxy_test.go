package httpapi

import (
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestTrustedProxyStripsUntrustedForwardedHeaders(t *testing.T) {
	called := false
	handler, err := TrustedProxy([]string{"127.0.0.0/8"}, http.HandlerFunc(func(_ http.ResponseWriter, request *http.Request) {
		called = true
		info := GetForwardedInfo(request.Context())
		if !info.ClientIP.Equal(net.ParseIP("203.0.113.9")) || !info.PeerIP.Equal(net.ParseIP("203.0.113.9")) || info.Host != "transport.test" || info.Proto != "http" || info.User != "" {
			t.Fatalf("ForwardedInfo = %#v", info)
		}
		for _, header := range []string{"X-Forwarded-For", "X-Forwarded-Host", "X-Forwarded-Proto", "X-Forwarded-User"} {
			if request.Header.Get(header) != "" {
				t.Fatalf("%s reached downstream", header)
			}
		}
	}))
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodGet, "http://transport.test", nil)
	request.RemoteAddr = "203.0.113.9:1234"
	request.Header.Set("X-Forwarded-For", "198.51.100.7")
	request.Header.Set("X-Forwarded-Host", "spoofed.test")
	request.Header.Set("X-Forwarded-Proto", "https")
	request.Header.Set("X-Forwarded-User", "spoofed")
	handler.ServeHTTP(httptest.NewRecorder(), request)
	if !called {
		t.Fatal("downstream was not called")
	}
}

func TestTrustedProxySelectsClientAcrossTrustedChain(t *testing.T) {
	handler, err := TrustedProxy([]string{"10.0.0.0/8", "127.0.0.0/8", "::1/128"}, http.HandlerFunc(func(_ http.ResponseWriter, request *http.Request) {
		info := GetForwardedInfo(request.Context())
		if !info.ClientIP.Equal(net.ParseIP("203.0.113.7")) || !info.PeerIP.Equal(net.ParseIP("10.0.0.3")) {
			t.Fatalf("IP selection = %#v", info)
		}
		if info.Host != "editor.example.test" || info.Proto != "https" || info.User != "editor@example.test" {
			t.Fatalf("forwarded values = %#v", info)
		}
	}))
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodGet, "http://transport.test", nil)
	request.RemoteAddr = "10.0.0.3:1234"
	request.Header.Set("X-Forwarded-For", "203.0.113.7, 10.0.0.2")
	request.Header.Set("X-Forwarded-Host", "editor.example.test")
	request.Header.Set("X-Forwarded-Proto", "https")
	request.Header.Set("X-Forwarded-User", "editor@example.test")
	handler.ServeHTTP(httptest.NewRecorder(), request)
}

func TestTrustedProxySupportsIPv6(t *testing.T) {
	handler, err := TrustedProxy([]string{"::1/128"}, http.HandlerFunc(func(_ http.ResponseWriter, request *http.Request) {
		info := GetForwardedInfo(request.Context())
		if !info.ClientIP.Equal(net.ParseIP("2001:db8::8")) || !info.PeerIP.Equal(net.ParseIP("::1")) {
			t.Fatalf("ForwardedInfo = %#v", info)
		}
	}))
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodGet, "http://transport.test", nil)
	request.RemoteAddr = "[::1]:443"
	request.Header.Set("X-Forwarded-For", "2001:db8::8, ::1")
	handler.ServeHTTP(httptest.NewRecorder(), request)
}

func TestTrustedProxyRejectsMalformedTrustedValues(t *testing.T) {
	for name, setHeader := range map[string]func(http.Header){
		"bad IP":         func(h http.Header) { h.Set("X-Forwarded-For", "client.test") },
		"bad host":       func(h http.Header) { h.Set("X-Forwarded-Host", "one.test,two.test") },
		"bad proto":      func(h http.Header) { h.Set("X-Forwarded-Proto", "ftp") },
		"duplicate user": func(h http.Header) { h.Add("X-Forwarded-User", "one"); h.Add("X-Forwarded-User", "two") },
	} {
		t.Run(name, func(t *testing.T) {
			called := false
			handler, err := TrustedProxy([]string{"127.0.0.0/8"}, http.HandlerFunc(func(http.ResponseWriter, *http.Request) { called = true }))
			if err != nil {
				t.Fatal(err)
			}
			request := httptest.NewRequest(http.MethodGet, "http://transport.test", nil)
			request.RemoteAddr = "127.0.0.1:1234"
			setHeader(request.Header)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != http.StatusBadRequest || called {
				t.Fatalf("status = %d, called = %v", response.Code, called)
			}
			for _, header := range []string{"X-Forwarded-For", "X-Forwarded-Host", "X-Forwarded-Proto", "X-Forwarded-User"} {
				if request.Header.Get(header) != "" {
					t.Fatalf("%s was not stripped", header)
				}
			}
		})
	}
}

func TestTrustedProxyRejectsInvalidCIDR(t *testing.T) {
	if _, err := TrustedProxy([]string{"not-a-cidr"}, http.NotFoundHandler()); err == nil {
		t.Fatal("TrustedProxy accepted invalid CIDR")
	}
}
