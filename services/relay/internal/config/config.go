package config

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
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

	// JWT / Auth
	JWTSecret     string
	JWTExpiry     time.Duration
	RefreshExpiry time.Duration

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

	jwtSecret := getEnv("JWT_SECRET", "nodus-development-secret-key-change-in-production-min-32-chars")
	if len(jwtSecret) < 16 {
		return nil, fmt.Errorf("JWT_SECRET must be at least 16 characters")
	}

	jwtExpiryMins, _ := strconv.Atoi(getEnv("JWT_EXPIRY_MINUTES", "15"))
	refreshExpiryDays, _ := strconv.Atoi(getEnv("REFRESH_EXPIRY_DAYS", "30"))

	defaultBufferDir := filepath.Join(os.TempDir(), "nodus-relay", "buffer")
	bufferDir := getEnv("BUFFER_DIR", defaultBufferDir)

	bufferTTLHours, _ := strconv.Atoi(getEnv("BUFFER_TTL_HOURS", "72"))

	cfg := &Config{
		ListenAddr:    listenAddr,
		DatabaseURL:   dbURL,
		RedisURL:      redisURL,
		JWTSecret:     jwtSecret,
		JWTExpiry:     time.Duration(jwtExpiryMins) * time.Minute,
		RefreshExpiry: time.Duration(refreshExpiryDays) * 24 * time.Hour,
		BufferDir:     bufferDir,
		BufferTTL:     time.Duration(bufferTTLHours) * time.Hour,
	}

	return cfg, nil
}

func getEnv(key, defaultVal string) string {
	if val, ok := os.LookupEnv(key); ok && val != "" {
		return val
	}
	return defaultVal
}
