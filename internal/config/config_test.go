package config

import (
	"strings"
	"testing"
	"time"
)

func TestLoadDefaults(t *testing.T) {
	c, err := load(env(baseEnv()))
	if err != nil {
		t.Fatal(err)
	}
	if c.ListenAddress != "127.0.0.1" || c.Port != 8787 || c.ListenAddr != "127.0.0.1:8787" {
		t.Fatalf("unexpected defaults: %#v", c)
	}
	if c.ReadTimeout != 15*time.Second || c.WriteTimeout != 0 || c.IdleTimeout != time.Minute {
		t.Fatalf("unexpected timeout defaults: %#v", c)
	}
	if c.AuthMode != "none" || c.PreviewGridMS != 500 {
		t.Fatalf("unexpected defaults: %#v", c)
	}
	if c.PublicBaseURL != "" || len(c.AllowedOrigins) != 0 {
		t.Fatalf("unexpected public settings: %#v", c)
	}
	if got := c.MediaRoots["camera"]; got != "/media/camera" {
		t.Fatalf("media root = %q", got)
	}
}

func TestLoadListenerConfiguration(t *testing.T) {
	for _, test := range []struct {
		name       string
		changes    map[string]string
		listenAddr string
		wantErr    bool
	}{
		{name: "default", listenAddr: "127.0.0.1:8787"},
		{name: "loopback port", changes: map[string]string{"EDITAPP_LISTEN_ADDRESS": "127.0.0.1", "EDITAPP_PORT": "1"}, listenAddr: "127.0.0.1:1"},
		{name: "LAN", changes: map[string]string{"EDITAPP_LISTEN_ADDRESS": "0.0.0.0", "EDITAPP_PORT": "4000"}, listenAddr: "0.0.0.0:4000"},
		{name: "IPv6", changes: map[string]string{"EDITAPP_LISTEN_ADDRESS": "::1", "EDITAPP_PORT": "4000"}, listenAddr: "[::1]:4000"},
		{name: "bearer LAN", changes: map[string]string{"EDITAPP_AUTH_MODE": "bearer", "EDITAPP_BEARER_TOKEN": "secret", "EDITAPP_LISTEN_ADDRESS": "0.0.0.0", "EDITAPP_PORT": "4000"}, listenAddr: "0.0.0.0:4000"},
		{name: "invalid IP", changes: map[string]string{"EDITAPP_LISTEN_ADDRESS": "localhost"}, wantErr: true},
		{name: "host port is not an IP", changes: map[string]string{"EDITAPP_LISTEN_ADDRESS": "127.0.0.1:9000"}, wantErr: true},
		{name: "zero port", changes: map[string]string{"EDITAPP_PORT": "0"}, wantErr: true},
		{name: "high port", changes: map[string]string{"EDITAPP_PORT": "65536"}, wantErr: true},
		{name: "invalid port", changes: map[string]string{"EDITAPP_PORT": "nope"}, wantErr: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			values := mergeEnv(baseEnv(), test.changes)
			c, err := load(env(values))
			if test.wantErr {
				if err == nil {
					t.Fatal("Load unexpectedly succeeded")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if c.ListenAddr != test.listenAddr {
				t.Fatalf("ListenAddr = %q, want %q", c.ListenAddr, test.listenAddr)
			}
		})
	}
}

func TestLoadParsesNetworkSettings(t *testing.T) {
	for _, test := range []struct {
		name    string
		changes map[string]string
		wantErr bool
	}{
		{name: "valid base URL", changes: map[string]string{"EDITAPP_PUBLIC_BASE_URL": "https://edit.example.test/app"}},
		{name: "valid exact origins", changes: map[string]string{"EDITAPP_ALLOWED_ORIGINS": "https://edit.example.test,http://localhost:5173"}},
		{name: "valid CIDRs", changes: map[string]string{"EDITAPP_TRUSTED_PROXY_CIDRS": "10.0.0.0/8,::1/128"}},
		{name: "bad base scheme", changes: map[string]string{"EDITAPP_PUBLIC_BASE_URL": "ftp://edit.example.test"}, wantErr: true},
		{name: "relative base URL", changes: map[string]string{"EDITAPP_PUBLIC_BASE_URL": "/app"}, wantErr: true},
		{name: "base URL credentials", changes: map[string]string{"EDITAPP_PUBLIC_BASE_URL": "https://user:pass@edit.example.test"}, wantErr: true},
		{name: "base URL query", changes: map[string]string{"EDITAPP_PUBLIC_BASE_URL": "https://edit.example.test/?x=1"}, wantErr: true},
		{name: "base URL fragment", changes: map[string]string{"EDITAPP_PUBLIC_BASE_URL": "https://edit.example.test/#top"}, wantErr: true},
		{name: "origin path", changes: map[string]string{"EDITAPP_ALLOWED_ORIGINS": "https://edit.example.test/app"}, wantErr: true},
		{name: "origin credentials", changes: map[string]string{"EDITAPP_ALLOWED_ORIGINS": "https://user:pass@edit.example.test"}, wantErr: true},
		{name: "origin query", changes: map[string]string{"EDITAPP_ALLOWED_ORIGINS": "https://edit.example.test/?x=1"}, wantErr: true},
		{name: "origin fragment", changes: map[string]string{"EDITAPP_ALLOWED_ORIGINS": "https://edit.example.test/#top"}, wantErr: true},
		{name: "origin bad scheme", changes: map[string]string{"EDITAPP_ALLOWED_ORIGINS": "ftp://edit.example.test"}, wantErr: true},
		{name: "empty origin entry", changes: map[string]string{"EDITAPP_ALLOWED_ORIGINS": "https://edit.example.test,"}, wantErr: true},
		{name: "bad CIDR", changes: map[string]string{"EDITAPP_TRUSTED_PROXY_CIDRS": "bad"}, wantErr: true},
		{name: "empty CIDR", changes: map[string]string{"EDITAPP_TRUSTED_PROXY_CIDRS": "127.0.0.1/32,"}, wantErr: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			_, err := load(env(mergeEnv(baseEnv(), test.changes)))
			if (err != nil) != test.wantErr {
				t.Fatalf("Load error = %v, want error %t", err, test.wantErr)
			}
		})
	}
}

func TestLoadStoresValidatedNetworkSettings(t *testing.T) {
	c, err := load(env(mergeEnv(baseEnv(), map[string]string{
		"EDITAPP_PUBLIC_BASE_URL":     "https://edit.example.test/app",
		"EDITAPP_ALLOWED_ORIGINS":     "https://edit.example.test, http://localhost:5173",
		"EDITAPP_TRUSTED_PROXY_CIDRS": "10.0.0.0/8,::1/128",
	})))
	if err != nil {
		t.Fatal(err)
	}
	if c.PublicBaseURL != "https://edit.example.test/app" {
		t.Fatalf("PublicBaseURL = %q", c.PublicBaseURL)
	}
	if got := strings.Join(c.AllowedOrigins, ","); got != "https://edit.example.test,http://localhost:5173" {
		t.Fatalf("AllowedOrigins = %q", got)
	}
	if got := strings.Join(c.TrustedProxyCIDRs, ","); got != "10.0.0.0/8,::1/128" {
		t.Fatalf("TrustedProxyCIDRs = %q", got)
	}
}

func TestLoadTimeouts(t *testing.T) {
	for _, test := range []struct {
		name        string
		changes     map[string]string
		read, write time.Duration
		idle        time.Duration
		wantErr     bool
	}{
		{name: "overrides", changes: map[string]string{"EDITAPP_READ_TIMEOUT": "2s", "EDITAPP_WRITE_TIMEOUT": "45s", "EDITAPP_IDLE_TIMEOUT": "3m"}, read: 2 * time.Second, write: 45 * time.Second, idle: 3 * time.Minute},
		{name: "streaming write timeout", changes: map[string]string{"EDITAPP_WRITE_TIMEOUT": "0s"}, read: 15 * time.Second, write: 0, idle: time.Minute},
		{name: "zero read", changes: map[string]string{"EDITAPP_READ_TIMEOUT": "0s"}, wantErr: true},
		{name: "negative read", changes: map[string]string{"EDITAPP_READ_TIMEOUT": "-1s"}, wantErr: true},
		{name: "negative write", changes: map[string]string{"EDITAPP_WRITE_TIMEOUT": "-1s"}, wantErr: true},
		{name: "zero idle", changes: map[string]string{"EDITAPP_IDLE_TIMEOUT": "0s"}, wantErr: true},
		{name: "invalid read", changes: map[string]string{"EDITAPP_READ_TIMEOUT": "soon"}, wantErr: true},
		{name: "invalid idle", changes: map[string]string{"EDITAPP_IDLE_TIMEOUT": "later"}, wantErr: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			c, err := load(env(mergeEnv(baseEnv(), test.changes)))
			if test.wantErr {
				if err == nil {
					t.Fatal("Load unexpectedly succeeded")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if c.ReadTimeout != test.read || c.WriteTimeout != test.write || c.IdleTimeout != test.idle {
				t.Fatalf("timeouts = (%s, %s, %s), want (%s, %s, %s)", c.ReadTimeout, c.WriteTimeout, c.IdleTimeout, test.read, test.write, test.idle)
			}
		})
	}
}

func TestLoadRejectsUnsafeConfiguration(t *testing.T) {
	for name, changes := range map[string]map[string]string{
		"unknown auth":         {"EDITAPP_AUTH_MODE": "oidc"},
		"bearer without token": {"EDITAPP_AUTH_MODE": "bearer"},
		"bad roots":            {"EDITAPP_MEDIA_ROOTS_JSON": "[]"},
		"window too large":     {"EDITAPP_PREVIEW_BEFORE_MS": "10000", "EDITAPP_PREVIEW_AFTER_MS": "6000"},
	} {
		t.Run(name, func(t *testing.T) {
			values := mergeEnv(baseEnv(), changes)
			if _, err := load(env(values)); err == nil {
				t.Fatal("Load unexpectedly succeeded")
			}
		})
	}
}

func env(values map[string]string) func(string) (string, bool) {
	return func(key string) (string, bool) {
		v, ok := values[key]
		return v, ok
	}
}

func TestLoadErrorNamesSetting(t *testing.T) {
	_, err := load(env(map[string]string{}))
	if err == nil || !strings.Contains(err.Error(), "EDITAPP_DATABASE_PATH") {
		t.Fatalf("error = %v", err)
	}
}

func baseEnv() map[string]string {
	return map[string]string{
		"EDITAPP_DATABASE_PATH":    "data/editapp.db",
		"EDITAPP_CACHE_DIR":        "data/cache",
		"EDITAPP_EXPORT_DIR":       "data/exports",
		"EDITAPP_MEDIA_ROOTS_JSON": `{"camera":"/media/camera"}`,
	}
}

func mergeEnv(base, changes map[string]string) map[string]string {
	values := make(map[string]string, len(base)+len(changes))
	for key, value := range base {
		values[key] = value
	}
	for key, value := range changes {
		values[key] = value
	}
	return values
}
