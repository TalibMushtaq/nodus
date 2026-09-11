package config

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Config holds all configuration variables for the Relay service.
type Config struct {
	// Server
	ListenAddr string

	// PostgreSQL
	DatabaseURL string

	// Redis
	RedisURL string

	// Sessions (opaque server-side auth, see Todo.md Phase 7a)
	SessionCookieName    string
	SessionMaxAge        time.Duration
	SessionTouchInterval time.Duration
	// SessionCookieSecure hardcodes the Secure flag; local dev over plain HTTP
	// must set SESSION_COOKIE_SECURE=false or browsers will drop the cookie.
	SessionCookieSecure bool
	AllowedOrigins      []string

	// TrustProxy marks the immediate peer as the operator's TLS reverse proxy
	// (single public origin, plan §3b). When true, the rate limiter trusts the
	// first X-Forwarded-For value; it must be false when the Relay is directly
	// reachable, or anyone can spoof their X-Forwarded-For.
	TrustProxy bool

	// Relay Shard Buffer
	BufferDir string
	BufferTTL time.Duration
}

// Load populates Config from environment variables with sensible defaults.
func Load() (*Config, error) {
	listenAddr := getEnv("PORT", "8080")
	if listenAddr != "" && listenAddr[0] != ':' {
		listenAddr = ":" + listenAddr
	}

	dbURL := getEnv("DATABASE_URL", "postgres://nodus:nodus_password@localhost:5432/nodus_relay?sslmode=disable")
	redisURL := getEnv("REDIS_URL", "redis://localhost:6379/0")

	sessionCookieName := getEnv("SESSION_COOKIE_NAME", "nodus_session")

	sessionMaxAgeDays, _ := strconv.Atoi(getEnv("SESSION_MAX_AGE_DAYS", "30"))
	if sessionMaxAgeDays <= 0 {
		sessionMaxAgeDays = 30
	}

	sessionTouchIntervalMins, _ := strconv.Atoi(getEnv("SESSION_TOUCH_INTERVAL_MINUTES", "30"))
	if sessionTouchIntervalMins <= 0 {
		sessionTouchIntervalMins = 30
	}

	sessionCookieSecure := true // Secure by default; dev over HTTP opts out explicitly.
	if v := getEnv("SESSION_COOKIE_SECURE", "true"); strings.EqualFold(v, "false") || v == "0" {
		sessionCookieSecure = false
	}
	origins := strings.FieldsFunc(getEnv("ALLOWED_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000"), func(r rune) bool { return r == ',' || r == ' ' })

	defaultBufferDir := filepath.Join(os.TempDir(), "nodus-relay", "buffer")
	bufferDir := getEnv("BUFFER_DIR", defaultBufferDir)

	bufferTTLHours, _ := strconv.Atoi(getEnv("BUFFER_TTL_HOURS", "72"))

	trustProxy := false
	if v := getEnv("TRUST_PROXY", "false"); strings.EqualFold(v, "true") || v == "1" {
		trustProxy = true
	}

	cfg := &Config{
		ListenAddr:           listenAddr,
		DatabaseURL:          dbURL,
		RedisURL:             redisURL,
		SessionCookieName:    sessionCookieName,
		SessionMaxAge:        time.Duration(sessionMaxAgeDays) * 24 * time.Hour,
		SessionTouchInterval: time.Duration(sessionTouchIntervalMins) * time.Minute,
		SessionCookieSecure:  sessionCookieSecure,
		AllowedOrigins:       origins,
		TrustProxy:           trustProxy,
		BufferDir:            bufferDir,
		BufferTTL:            time.Duration(bufferTTLHours) * time.Hour,
	}

	return cfg, nil
}

func getEnv(key, defaultVal string) string {
	if val, ok := os.LookupEnv(key); ok && val != "" {
		return val
	}
	return defaultVal
}
