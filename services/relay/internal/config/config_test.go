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
	if cfg.SessionCookieName != "nodus_session" {
		t.Fatalf("expected default SessionCookieName nodus_session, got %s", cfg.SessionCookieName)
	}
	if cfg.SessionMaxAge != 30*24*time.Hour {
		t.Fatalf("expected default SessionMaxAge 30d, got %v", cfg.SessionMaxAge)
	}
	if cfg.SessionTouchInterval != 30*time.Minute {
		t.Fatalf("expected default SessionTouchInterval 30m, got %v", cfg.SessionTouchInterval)
	}
	if !cfg.SessionCookieSecure {
		t.Fatalf("expected SessionCookieSecure to default to true")
	}
	if cfg.BufferTTL != 72*time.Hour {
		t.Fatalf("expected default BufferTTL 72h, got %v", cfg.BufferTTL)
	}
}

func TestConfigEnvOverrides(t *testing.T) {
	os.Setenv("PORT", "9090")
	os.Setenv("SESSION_COOKIE_NAME", "custom_session")
	os.Setenv("SESSION_MAX_AGE_DAYS", "7")
	os.Setenv("SESSION_TOUCH_INTERVAL_MINUTES", "10")
	os.Setenv("SESSION_COOKIE_SECURE", "false")
	os.Setenv("BUFFER_TTL_HOURS", "48")
	defer func() {
		os.Unsetenv("PORT")
		os.Unsetenv("SESSION_COOKIE_NAME")
		os.Unsetenv("SESSION_MAX_AGE_DAYS")
		os.Unsetenv("SESSION_TOUCH_INTERVAL_MINUTES")
		os.Unsetenv("SESSION_COOKIE_SECURE")
		os.Unsetenv("BUFFER_TTL_HOURS")
	}()

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("unexpected error loading overridden config: %v", err)
	}

	if cfg.ListenAddr != ":9090" {
		t.Fatalf("expected ListenAddr :9090, got %s", cfg.ListenAddr)
	}
	if cfg.SessionCookieName != "custom_session" {
		t.Fatalf("expected custom SessionCookieName, got %s", cfg.SessionCookieName)
	}
	if cfg.SessionMaxAge != 7*24*time.Hour {
		t.Fatalf("expected SessionMaxAge 7d, got %v", cfg.SessionMaxAge)
	}
	if cfg.SessionTouchInterval != 10*time.Minute {
		t.Fatalf("expected SessionTouchInterval 10m, got %v", cfg.SessionTouchInterval)
	}
	if cfg.SessionCookieSecure {
		t.Fatalf("expected SessionCookieSecure false, got true")
	}
	if cfg.BufferTTL != 48*time.Hour {
		t.Fatalf("expected BufferTTL 48h, got %v", cfg.BufferTTL)
	}
}
