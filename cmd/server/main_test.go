package main

import (
	"errors"
	"net"
	"net/http"
	"testing"
	"time"

	"editapp/infrastructure/config"
)

func TestNewHTTPServerUsesConfiguredAddressAndTimeouts(t *testing.T) {
	cfg := config.Config{
		ListenAddr:   "127.0.0.1:0",
		ReadTimeout:  2 * time.Second,
		WriteTimeout: 0,
		IdleTimeout:  3 * time.Minute,
	}
	server := newHTTPServer(cfg, http.NewServeMux())
	if server.Addr != cfg.ListenAddr || server.ReadTimeout != cfg.ReadTimeout || server.WriteTimeout != cfg.WriteTimeout || server.IdleTimeout != cfg.IdleTimeout {
		t.Fatalf("server = %#v, config = %#v", server, cfg)
	}
	if server.ReadHeaderTimeout != 5*time.Second {
		t.Fatalf("ReadHeaderTimeout = %s, want 5s", server.ReadHeaderTimeout)
	}
}

func TestNewHTTPServerBindsConfiguredAddresses(t *testing.T) {
	for _, test := range []struct {
		name string
		addr string
	}{
		{name: "loopback", addr: "127.0.0.1:0"},
		{name: "all IPv4 interfaces", addr: "0.0.0.0:0"},
	} {
		t.Run(test.name, func(t *testing.T) {
			server := newHTTPServer(config.Config{ListenAddr: test.addr}, http.NewServeMux())
			listener, err := net.Listen("tcp", server.Addr)
			if err != nil {
				t.Fatal(err)
			}
			defer listener.Close()
			if _, port, err := net.SplitHostPort(listener.Addr().String()); err != nil || port == "0" {
				t.Fatalf("listener address = %q, err = %v", listener.Addr(), err)
			}
		})
	}
}

func TestNewHTTPServerServesLoopback(t *testing.T) {
	server := newHTTPServer(config.Config{ListenAddr: "127.0.0.1:0"}, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	listener, err := net.Listen("tcp", server.Addr)
	if err != nil {
		t.Fatal(err)
	}
	result := make(chan error, 1)
	go func() { result <- server.Serve(listener) }()

	response, err := http.Get("http://" + listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusNoContent {
		t.Fatalf("status = %d, want %d", response.StatusCode, http.StatusNoContent)
	}
	if err := server.Close(); err != nil {
		t.Fatal(err)
	}
	if err := <-result; !errors.Is(err, http.ErrServerClosed) {
		t.Fatalf("Serve error = %v, want %v", err, http.ErrServerClosed)
	}
}
