// Package config loads the process configuration from EDITAPP_* variables.
package config

import (
	"encoding/json"
	"fmt"
	"net"
	"os"
	"strconv"
	"strings"
)

const (
	defaultListenAddr        = "127.0.0.1:8787"
	defaultTrustedProxies    = "127.0.0.0/8,::1/128"
	defaultFFmpegPath        = "ffmpeg"
	defaultFFprobePath       = "ffprobe"
	defaultPreviewGlobal     = 2
	defaultPreviewPerUser    = 1
	defaultExportLimit       = 1
	defaultCacheMaxBytes     = int64(20 << 30)
	defaultPreviewBeforeMS   = 2_000
	defaultPreviewAfterMS    = 6_000
	defaultPreviewMaxMS      = 15_000
	defaultPreviewGridMS     = 500
	defaultEncoderPreference = "software"
	defaultLogLevel          = "info"
)

// Config contains process settings only; filesystem access and service setup
// belong to their respective packages.
type Config struct {
	ListenAddr          string
	DatabasePath        string
	CacheDir            string
	ExportDir           string
	MediaRoots          map[string]string
	AuthMode            string
	DevUserLogin        string
	TrustedProxyCIDRs   []string
	FFmpegPath          string
	FFprobePath         string
	PreviewGlobalLimit  int
	PreviewPerUserLimit int
	ExportLimit         int
	CacheMaxBytes       int64
	PreviewBeforeMS     int
	PreviewAfterMS      int
	PreviewMaxMS        int
	PreviewGridMS       int
	EncoderPreference   string
	LogLevel            string
}

// Load reads and validates EDITAPP_* environment variables.
func Load() (Config, error) {
	return load(os.LookupEnv)
}

func load(lookup func(string) (string, bool)) (Config, error) {
	c := Config{
		ListenAddr:        value(lookup, "EDITAPP_LISTEN_ADDR", defaultListenAddr),
		DatabasePath:      required(lookup, "EDITAPP_DATABASE_PATH"),
		CacheDir:          required(lookup, "EDITAPP_CACHE_DIR"),
		ExportDir:         required(lookup, "EDITAPP_EXPORT_DIR"),
		AuthMode:          value(lookup, "EDITAPP_AUTH_MODE", "tailscale"),
		DevUserLogin:      value(lookup, "EDITAPP_DEV_USER_LOGIN", ""),
		FFmpegPath:        value(lookup, "EDITAPP_FFMPEG_PATH", defaultFFmpegPath),
		FFprobePath:       value(lookup, "EDITAPP_FFPROBE_PATH", defaultFFprobePath),
		EncoderPreference: value(lookup, "EDITAPP_ENCODER_PREFERENCE", defaultEncoderPreference),
		LogLevel:          value(lookup, "EDITAPP_LOG_LEVEL", defaultLogLevel),
	}
	if err := validateListenAddr(c.ListenAddr); err != nil {
		return Config{}, err
	}
	if c.DatabasePath == "" || c.CacheDir == "" || c.ExportDir == "" {
		return Config{}, fmt.Errorf("EDITAPP_DATABASE_PATH, EDITAPP_CACHE_DIR, and EDITAPP_EXPORT_DIR are required")
	}
	if err := json.Unmarshal([]byte(required(lookup, "EDITAPP_MEDIA_ROOTS_JSON")), &c.MediaRoots); err != nil || len(c.MediaRoots) == 0 {
		return Config{}, fmt.Errorf("EDITAPP_MEDIA_ROOTS_JSON must be a non-empty JSON object")
	}
	for alias, path := range c.MediaRoots {
		if strings.TrimSpace(alias) == "" || strings.TrimSpace(path) == "" {
			return Config{}, fmt.Errorf("EDITAPP_MEDIA_ROOTS_JSON contains an empty alias or path")
		}
	}
	if c.AuthMode != "tailscale" && c.AuthMode != "dev" {
		return Config{}, fmt.Errorf("EDITAPP_AUTH_MODE must be tailscale or dev")
	}
	if c.AuthMode == "dev" && c.DevUserLogin == "" {
		return Config{}, fmt.Errorf("EDITAPP_DEV_USER_LOGIN is required in dev mode")
	}
	trusted := value(lookup, "EDITAPP_TRUSTED_PROXY_CIDRS", defaultTrustedProxies)
	for _, cidr := range strings.Split(trusted, ",") {
		cidr = strings.TrimSpace(cidr)
		if cidr == "" {
			return Config{}, fmt.Errorf("EDITAPP_TRUSTED_PROXY_CIDRS contains an empty CIDR")
		}
		if _, _, err := net.ParseCIDR(cidr); err != nil {
			return Config{}, fmt.Errorf("EDITAPP_TRUSTED_PROXY_CIDRS: %w", err)
		}
		c.TrustedProxyCIDRs = append(c.TrustedProxyCIDRs, cidr)
	}
	var err error
	if c.PreviewGlobalLimit, err = positiveInt(lookup, "EDITAPP_PREVIEW_GLOBAL_LIMIT", defaultPreviewGlobal); err != nil {
		return Config{}, err
	}
	if c.PreviewPerUserLimit, err = positiveInt(lookup, "EDITAPP_PREVIEW_PER_USER_LIMIT", defaultPreviewPerUser); err != nil {
		return Config{}, err
	}
	if c.ExportLimit, err = positiveInt(lookup, "EDITAPP_EXPORT_LIMIT", defaultExportLimit); err != nil {
		return Config{}, err
	}
	if c.CacheMaxBytes, err = positiveInt64(lookup, "EDITAPP_CACHE_MAX_BYTES", defaultCacheMaxBytes); err != nil {
		return Config{}, err
	}
	if c.PreviewBeforeMS, err = positiveInt(lookup, "EDITAPP_PREVIEW_BEFORE_MS", defaultPreviewBeforeMS); err != nil {
		return Config{}, err
	}
	if c.PreviewAfterMS, err = positiveInt(lookup, "EDITAPP_PREVIEW_AFTER_MS", defaultPreviewAfterMS); err != nil {
		return Config{}, err
	}
	if c.PreviewMaxMS, err = positiveInt(lookup, "EDITAPP_PREVIEW_MAX_MS", defaultPreviewMaxMS); err != nil {
		return Config{}, err
	}
	if c.PreviewGridMS, err = positiveInt(lookup, "EDITAPP_PREVIEW_GRID_MS", defaultPreviewGridMS); err != nil {
		return Config{}, err
	}
	if c.PreviewBeforeMS+c.PreviewAfterMS > c.PreviewMaxMS {
		return Config{}, fmt.Errorf("EDITAPP_PREVIEW_MAX_MS must cover the default preview window")
	}
	if c.LogLevel != "debug" && c.LogLevel != "info" && c.LogLevel != "warn" && c.LogLevel != "error" {
		return Config{}, fmt.Errorf("EDITAPP_LOG_LEVEL must be debug, info, warn, or error")
	}
	return c, nil
}

func value(lookup func(string) (string, bool), key, fallback string) string {
	if v, ok := lookup(key); ok {
		return strings.TrimSpace(v)
	}
	return fallback
}

func required(lookup func(string) (string, bool), key string) string {
	return value(lookup, key, "")
}

func positiveInt(lookup func(string) (string, bool), key string, fallback int) (int, error) {
	v, err := strconv.Atoi(value(lookup, key, strconv.Itoa(fallback)))
	if err != nil || v < 1 {
		return 0, fmt.Errorf("%s must be a positive integer", key)
	}
	return v, nil
}

func positiveInt64(lookup func(string) (string, bool), key string, fallback int64) (int64, error) {
	v, err := strconv.ParseInt(value(lookup, key, strconv.FormatInt(fallback, 10)), 10, 64)
	if err != nil || v < 1 {
		return 0, fmt.Errorf("%s must be a positive integer", key)
	}
	return v, nil
}

func validateListenAddr(addr string) error {
	host, port, err := net.SplitHostPort(addr)
	if err != nil || !net.ParseIP(host).IsLoopback() {
		return fmt.Errorf("EDITAPP_LISTEN_ADDR must use a loopback IP and port")
	}
	n, err := strconv.Atoi(port)
	if err != nil || n < 1 || n > 65535 {
		return fmt.Errorf("EDITAPP_LISTEN_ADDR must use a valid port")
	}
	return nil
}
