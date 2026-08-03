// Package config loads the process configuration from VIDEOCUTLIST_* variables.
package config

import (
	"encoding/json"
	"fmt"
	"net"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
	"unicode"
)

const (
	defaultListenAddress   = "127.0.0.1"
	defaultPort            = 8787
	defaultTrustedProxies  = "127.0.0.0/8,::1/128"
	defaultFFmpegPath      = "ffmpeg"
	defaultFFprobePath     = "ffprobe"
	defaultPreviewGlobal   = 2
	defaultPreviewPerUser  = 1
	defaultExportLimit     = 1
	defaultCacheMaxBytes   = int64(20 << 30)
	defaultPreviewBeforeMS = 2_000
	defaultPreviewAfterMS  = 6_000
	defaultPreviewMaxMS    = 15_000
	defaultPreviewGridMS   = 500
)

// Config contains process settings only; filesystem access and service setup
// belong to their respective packages.
type Config struct {
	ListenAddress       string
	Port                int
	ListenAddr          string
	PublicBaseURL       string
	AllowedOrigins      []string
	ReadTimeout         time.Duration
	WriteTimeout        time.Duration
	IdleTimeout         time.Duration
	DatabasePath        string
	CacheDir            string
	ExportDir           string
	MediaRoots          map[string]string
	AuthMode            string
	BearerToken         string
	BearerSubject       string
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
}

// Load reads and validates VIDEOCUTLIST_* environment variables.
func Load() (Config, error) {
	return load(os.LookupEnv)
}

func load(lookup func(string) (string, bool)) (Config, error) {
	c := Config{
		DatabasePath:  required(lookup, "VIDEOCUTLIST_DATABASE_PATH"),
		CacheDir:      required(lookup, "VIDEOCUTLIST_CACHE_DIR"),
		ExportDir:     required(lookup, "VIDEOCUTLIST_EXPORT_DIR"),
		AuthMode:      value(lookup, "VIDEOCUTLIST_AUTH_MODE", "none"),
		BearerToken:   value(lookup, "VIDEOCUTLIST_BEARER_TOKEN", ""),
		BearerSubject: value(lookup, "VIDEOCUTLIST_BEARER_SUBJECT", "static-bearer"),
		FFmpegPath:    value(lookup, "VIDEOCUTLIST_FFMPEG_PATH", defaultFFmpegPath),
		FFprobePath:   value(lookup, "VIDEOCUTLIST_FFPROBE_PATH", defaultFFprobePath),
	}
	if err := loadListener(&c, lookup); err != nil {
		return Config{}, err
	}
	var err error
	if c.PublicBaseURL, err = absoluteHTTPURL(lookup, "VIDEOCUTLIST_PUBLIC_BASE_URL", false); err != nil {
		return Config{}, err
	}
	if c.AllowedOrigins, err = allowedOrigins(lookup); err != nil {
		return Config{}, err
	}
	if c.ReadTimeout, err = duration(lookup, "VIDEOCUTLIST_READ_TIMEOUT", 15*time.Second, true); err != nil {
		return Config{}, err
	}
	if c.WriteTimeout, err = duration(lookup, "VIDEOCUTLIST_WRITE_TIMEOUT", 0, false); err != nil {
		return Config{}, err
	}
	if c.IdleTimeout, err = duration(lookup, "VIDEOCUTLIST_IDLE_TIMEOUT", time.Minute, true); err != nil {
		return Config{}, err
	}
	if c.DatabasePath == "" || c.CacheDir == "" || c.ExportDir == "" {
		return Config{}, fmt.Errorf("VIDEOCUTLIST_DATABASE_PATH, VIDEOCUTLIST_CACHE_DIR, and VIDEOCUTLIST_EXPORT_DIR are required")
	}
	if err := json.Unmarshal([]byte(required(lookup, "VIDEOCUTLIST_MEDIA_ROOTS_JSON")), &c.MediaRoots); err != nil || len(c.MediaRoots) == 0 {
		return Config{}, fmt.Errorf("VIDEOCUTLIST_MEDIA_ROOTS_JSON must be a non-empty JSON object")
	}
	for alias, path := range c.MediaRoots {
		if strings.TrimSpace(alias) == "" || strings.TrimSpace(path) == "" {
			return Config{}, fmt.Errorf("VIDEOCUTLIST_MEDIA_ROOTS_JSON contains an empty alias or path")
		}
	}
	if c.AuthMode != "none" && c.AuthMode != "bearer" && c.AuthMode != "trusted_proxy" {
		return Config{}, fmt.Errorf("VIDEOCUTLIST_AUTH_MODE must be none, bearer, or trusted_proxy")
	}
	if c.AuthMode == "bearer" {
		if c.BearerToken == "" || containsControl(c.BearerToken) {
			return Config{}, fmt.Errorf("VIDEOCUTLIST_BEARER_TOKEN must be non-empty and control-free in bearer mode")
		}
		if c.BearerSubject == "" || c.BearerSubject != strings.TrimSpace(c.BearerSubject) || len(c.BearerSubject) > 320 || containsControl(c.BearerSubject) {
			return Config{}, fmt.Errorf("VIDEOCUTLIST_BEARER_SUBJECT must be a trimmed, non-empty, control-free subject of at most 320 bytes")
		}
	}
	trusted := value(lookup, "VIDEOCUTLIST_TRUSTED_PROXY_CIDRS", defaultTrustedProxies)
	for _, cidr := range strings.Split(trusted, ",") {
		cidr = strings.TrimSpace(cidr)
		if cidr == "" {
			return Config{}, fmt.Errorf("VIDEOCUTLIST_TRUSTED_PROXY_CIDRS contains an empty CIDR")
		}
		if _, _, err := net.ParseCIDR(cidr); err != nil {
			return Config{}, fmt.Errorf("VIDEOCUTLIST_TRUSTED_PROXY_CIDRS: %w", err)
		}
		c.TrustedProxyCIDRs = append(c.TrustedProxyCIDRs, cidr)
	}
	if c.PreviewGlobalLimit, err = positiveInt(lookup, "VIDEOCUTLIST_PREVIEW_GLOBAL_LIMIT", defaultPreviewGlobal); err != nil {
		return Config{}, err
	}
	if c.PreviewPerUserLimit, err = positiveInt(lookup, "VIDEOCUTLIST_PREVIEW_PER_USER_LIMIT", defaultPreviewPerUser); err != nil {
		return Config{}, err
	}
	if c.ExportLimit, err = positiveInt(lookup, "VIDEOCUTLIST_EXPORT_LIMIT", defaultExportLimit); err != nil {
		return Config{}, err
	}
	if c.CacheMaxBytes, err = positiveInt64(lookup, "VIDEOCUTLIST_CACHE_MAX_BYTES", defaultCacheMaxBytes); err != nil {
		return Config{}, err
	}
	if c.PreviewBeforeMS, err = positiveInt(lookup, "VIDEOCUTLIST_PREVIEW_BEFORE_MS", defaultPreviewBeforeMS); err != nil {
		return Config{}, err
	}
	if c.PreviewAfterMS, err = positiveInt(lookup, "VIDEOCUTLIST_PREVIEW_AFTER_MS", defaultPreviewAfterMS); err != nil {
		return Config{}, err
	}
	if c.PreviewMaxMS, err = positiveInt(lookup, "VIDEOCUTLIST_PREVIEW_MAX_MS", defaultPreviewMaxMS); err != nil {
		return Config{}, err
	}
	if c.PreviewGridMS, err = positiveInt(lookup, "VIDEOCUTLIST_PREVIEW_GRID_MS", defaultPreviewGridMS); err != nil {
		return Config{}, err
	}
	if c.PreviewBeforeMS+c.PreviewAfterMS > c.PreviewMaxMS {
		return Config{}, fmt.Errorf("VIDEOCUTLIST_PREVIEW_MAX_MS must cover the default preview window")
	}
	return c, nil
}

func loadListener(c *Config, lookup func(string) (string, bool)) error {
	c.ListenAddress = value(lookup, "VIDEOCUTLIST_LISTEN_ADDRESS", defaultListenAddress)
	if net.ParseIP(c.ListenAddress) == nil {
		return fmt.Errorf("VIDEOCUTLIST_LISTEN_ADDRESS must be an IP literal")
	}
	var err error
	c.Port, err = parsePort(value(lookup, "VIDEOCUTLIST_PORT", strconv.Itoa(defaultPort)), "VIDEOCUTLIST_PORT")
	if err != nil {
		return err
	}
	c.ListenAddr = net.JoinHostPort(c.ListenAddress, strconv.Itoa(c.Port))
	return nil
}

func parsePort(value, setting string) (int, error) {
	port, err := strconv.Atoi(value)
	if err != nil || port < 1 || port > 65535 {
		return 0, fmt.Errorf("%s must be an integer from 1 through 65535", setting)
	}
	return port, nil
}

func absoluteHTTPURL(lookup func(string) (string, bool), setting string, origin bool) (string, error) {
	return parseHTTPURL(value(lookup, setting, ""), setting, origin)
}

func parseHTTPURL(raw, setting string, origin bool) (string, error) {
	if raw == "" {
		return "", nil
	}
	u, err := url.ParseRequestURI(raw)
	if strings.Contains(raw, "#") || err != nil || u.Scheme != "http" && u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || u.Opaque != "" || origin && u.Path != "" {
		kind := "URL"
		if origin {
			kind = "origin"
		}
		return "", fmt.Errorf("%s must be an absolute HTTP(S) %s without credentials, query, or fragment", setting, kind)
	}
	if err := validURLPort(u); err != nil {
		return "", fmt.Errorf("%s must use a valid URL port: %w", setting, err)
	}
	return u.String(), nil
}

func validURLPort(u *url.URL) error {
	host := u.Host
	if strings.HasPrefix(host, "[") {
		end := strings.LastIndex(host, "]")
		if end < 0 {
			return fmt.Errorf("invalid host")
		}
		if end == len(host)-1 {
			return nil
		}
		_, port, err := net.SplitHostPort(host)
		if err != nil {
			return err
		}
		_, err = parsePort(port, "port")
		return err
	}
	if strings.Count(host, ":") == 1 {
		_, port, _ := strings.Cut(host, ":")
		if port == "" {
			return fmt.Errorf("missing port")
		}
		_, err := parsePort(port, "port")
		return err
	}
	return nil
}

func allowedOrigins(lookup func(string) (string, bool)) ([]string, error) {
	raw := value(lookup, "VIDEOCUTLIST_ALLOWED_ORIGINS", "")
	if raw == "" {
		return nil, nil
	}
	origins := strings.Split(raw, ",")
	for i, origin := range origins {
		origin = strings.TrimSpace(origin)
		if origin == "" {
			return nil, fmt.Errorf("VIDEOCUTLIST_ALLOWED_ORIGINS contains an empty origin")
		}
		parsed, err := parseHTTPURL(origin, "VIDEOCUTLIST_ALLOWED_ORIGINS", true)
		if err != nil {
			return nil, err
		}
		origins[i] = parsed
	}
	return origins, nil
}

func duration(lookup func(string) (string, bool), setting string, fallback time.Duration, positive bool) (time.Duration, error) {
	raw := value(lookup, setting, fallback.String())
	duration, err := time.ParseDuration(raw)
	if err != nil || duration < 0 || positive && duration == 0 {
		if positive {
			return 0, fmt.Errorf("%s must be a positive Go duration", setting)
		}
		return 0, fmt.Errorf("%s must be a non-negative Go duration", setting)
	}
	return duration, nil
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

func containsControl(value string) bool {
	return strings.IndexFunc(value, unicode.IsControl) >= 0
}
