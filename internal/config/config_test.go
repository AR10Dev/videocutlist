package config

import (
	"strings"
	"testing"
)

func TestLoadDefaults(t *testing.T) {
	c, err := load(env(map[string]string{
		"EDITAPP_DATABASE_PATH":    "data/editapp.db",
		"EDITAPP_CACHE_DIR":        "data/cache",
		"EDITAPP_EXPORT_DIR":       "data/exports",
		"EDITAPP_MEDIA_ROOTS_JSON": `{"camera":"/media/camera"}`,
	}))
	if err != nil {
		t.Fatal(err)
	}
	if c.ListenAddr != "127.0.0.1:8787" || c.AuthMode != "tailscale" || c.PreviewGridMS != 500 {
		t.Fatalf("unexpected defaults: %#v", c)
	}
	if got := c.MediaRoots["camera"]; got != "/media/camera" {
		t.Fatalf("media root = %q", got)
	}
}

func TestLoadRejectsUnsafeConfiguration(t *testing.T) {
	base := map[string]string{
		"EDITAPP_DATABASE_PATH":    "data/editapp.db",
		"EDITAPP_CACHE_DIR":        "data/cache",
		"EDITAPP_EXPORT_DIR":       "data/exports",
		"EDITAPP_MEDIA_ROOTS_JSON": `{"camera":"/media/camera"}`,
	}
	for name, changes := range map[string]map[string]string{
		"public listener":  {"EDITAPP_LISTEN_ADDR": "0.0.0.0:8787"},
		"unknown auth":     {"EDITAPP_AUTH_MODE": "none"},
		"dev without user": {"EDITAPP_AUTH_MODE": "dev"},
		"bad roots":        {"EDITAPP_MEDIA_ROOTS_JSON": "[]"},
		"bad cidr":         {"EDITAPP_TRUSTED_PROXY_CIDRS": "bad"},
		"window too large": {"EDITAPP_PREVIEW_BEFORE_MS": "10000", "EDITAPP_PREVIEW_AFTER_MS": "6000"},
	} {
		t.Run(name, func(t *testing.T) {
			values := make(map[string]string, len(base)+len(changes))
			for k, v := range base {
				values[k] = v
			}
			for k, v := range changes {
				values[k] = v
			}
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
