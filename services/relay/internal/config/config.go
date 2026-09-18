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
	// MaxShardBytes is the largest *plaintext* shard the Relay will accept and
	// relay onward. The buffer upload cap and the WebSocket read limit are
	// derived from it (with framing headroom), so raising this one value lets
	// clients use larger shards. Default 32 MiB, matching @repo/core's
	// MAX_SHARD_SIZE_BYTES: a smaller default silently rejected every shard from
	// clients configured with the 16/32 MiB Settings options, and the rejected
	// uploads fell through to the device-local queue. Env MAX_SHARD_BYTES_MB.
	MaxShardBytes int64

	// Push notifications (Phase 3). Optional Expo access token; when empty the
	// sender still posts to Expo, which permits low-volume unauthenticated use.
	ExpoPushAccessToken string

	// Web Push (VAPID). Browser push is disabled unless both keys are set.
	VAPIDPublicKey  string
	VAPIDPrivateKey string
	VAPIDSubject    string
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

	// Shard size is a client choice; the Relay must be configured to accept it.
	// The default is the clients' maximum (32 MiB) so the Settings shard-size
	// options never silently exceed the buffer cap; a value below 1 is treated
	// as unset and falls back to that same default.
	maxShardMB, _ := strconv.Atoi(getEnv("MAX_SHARD_BYTES_MB", "32"))
	if maxShardMB < 1 {
		maxShardMB = 32
	}
	maxShardBytes := int64(maxShardMB) * 1024 * 1024

	trustProxy := false
	if v := getEnv("TRUST_PROXY", "false"); strings.EqualFold(v, "true") || v == "1" {
		trustProxy = true
	}

	expoPushAccessToken := getEnv("EXPO_PUSH_ACCESS_TOKEN", "")
	vapidPublicKey := getEnv("VAPID_PUBLIC_KEY", "")
	vapidPrivateKey := getEnv("VAPID_PRIVATE_KEY", "")
	vapidSubject := getEnv("VAPID_SUBJECT", "mailto:admin@example.com")

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
		MaxShardBytes:        maxShardBytes,
		ExpoPushAccessToken:  expoPushAccessToken,
		VAPIDPublicKey:       vapidPublicKey,
		VAPIDPrivateKey:      vapidPrivateKey,
		VAPIDSubject:         vapidSubject,
	}

	return cfg, nil
}

func getEnv(key, defaultVal string) string {
	if val, ok := os.LookupEnv(key); ok && val != "" {
		return val
	}
	return defaultVal
}
