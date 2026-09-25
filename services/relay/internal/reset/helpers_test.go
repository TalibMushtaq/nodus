package reset

import (
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/TalibMushtaq/nodus/services/relay/internal/config"
)

// testConfig builds a Config carrying the three destructive targets plus
// credentials, so tests can assert the confirmation output names the target
// without leaking the credentials.
func testConfig() *config.Config {
	return &config.Config{
		DatabaseURL: "postgres://relayadmin:supersecret@127.0.0.1:5432/nodus_relay?sslmode=disable",
		RedisURL:    "redis://:redispass@127.0.0.1:6379/3",
		BufferDir:   filepath.Join("/var/lib/nodus", "buffer"),
	}
}

func TestTestConfigPointsAtDistinctTargets(t *testing.T) {
	cfg := testConfig()
	require.NotEqual(t, cfg.DatabaseURL, cfg.RedisURL)
	require.Equal(t, "/var/lib/nodus/buffer", cfg.BufferDir)
}
