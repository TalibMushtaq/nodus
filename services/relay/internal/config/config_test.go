package config_test

import (
	"os"
	"testing"
	"time"

	"github.com/TalibMushtaq/nodus/services/relay/internal/config"
)

func TestConfigDefaults(t *testing.T) {
	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("unexpected error loading default config: %v", err)
	}

	if cfg.ListenAddr != ":8080" {
		t.Fatalf("expected default ListenAddr :8080, got %s", cfg.ListenAddr)
	}
	if cfg.JWTExpiry != 15*time.Minute {
		t.Fatalf("expected default JWTExpiry 15m, got %v", cfg.JWTExpiry)
	}
	if cfg.BufferTTL != 72*time.Hour {
		t.Fatalf("expected default BufferTTL 72h, got %v", cfg.BufferTTL)
	}
}

func TestConfigEnvOverrides(t *testing.T) {
	os.Setenv("PORT", "9090")
	os.Setenv("JWT_SECRET", "custom-secret-key-1234567890")
	os.Setenv("BUFFER_TTL_HOURS", "48")
	defer func() {
		os.Unsetenv("PORT")
		os.Unsetenv("JWT_SECRET")
		os.Unsetenv("BUFFER_TTL_HOURS")
	}()

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("unexpected error loading overridden config: %v", err)
	}

	if cfg.ListenAddr != ":9090" {
		t.Fatalf("expected ListenAddr :9090, got %s", cfg.ListenAddr)
	}
	if cfg.JWTSecret != "custom-secret-key-1234567890" {
		t.Fatalf("expected custom JWTSecret, got %s", cfg.JWTSecret)
	}
	if cfg.BufferTTL != 48*time.Hour {
		t.Fatalf("expected BufferTTL 48h, got %v", cfg.BufferTTL)
	}
}
