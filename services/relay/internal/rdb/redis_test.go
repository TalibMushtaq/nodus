package rdb

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/TalibMushtaq/nodus/services/relay/internal/config"
)

// TestPasswordedRedisURL authenticates over the URL form the deployment
// renders: deploy/docker-compose.yml sets
// REDIS_URL=redis://:${REDIS_PASSWORD}@redis:6379/0 so that Redis, which holds
// fetch tokens and auth nonces rather than cache entries, requires a password.
//
// Set TEST_REDIS_AUTH_URL to a passworded Redis to run it, e.g.
//
//	TEST_REDIS_AUTH_URL=redis://:pw@127.0.0.1:6379/0 go test ./internal/rdb/
func TestPasswordedRedisURL(t *testing.T) {
	url := os.Getenv("TEST_REDIS_AUTH_URL")
	if url == "" {
		t.Skip("TEST_REDIS_AUTH_URL not set; skipping authenticated-Redis test")
	}
	ctx := context.Background()

	c, err := Open(ctx, &config.Config{RedisURL: url})
	if err != nil {
		t.Fatalf("Open with a correct password: %v", err)
	}
	defer c.Close()

	peer := "node-auth-check"
	if err := c.SetPresence(ctx, peer, time.Minute); err != nil {
		t.Fatalf("SetPresence over an authenticated connection: %v", err)
	}
	ok, err := c.IsPresent(ctx, peer)
	if err != nil || !ok {
		t.Fatalf("IsPresent = %v, %v; want true, nil", ok, err)
	}
}

// TestRedisURLCarriesNoPassword is the negative half: a client that silently
// connected without the configured password would make requirepass decorative,
// so a wrong password has to fail rather than fall back to an unauthenticated
// connection.
func TestRedisURLCarriesNoPassword(t *testing.T) {
	url := os.Getenv("TEST_REDIS_AUTH_URL")
	if url == "" {
		t.Skip("TEST_REDIS_AUTH_URL not set; skipping authenticated-Redis test")
	}
	// Swap the password for a wrong one, leaving host and port intact.
	bad := strings.Replace(url, "redis://:", "redis://:wrong-password-", 1)
	if bad == url {
		t.Fatal("TEST_REDIS_AUTH_URL has no password component to replace")
	}
	c, err := Open(context.Background(), &config.Config{RedisURL: bad})
	if err == nil {
		_ = c.Close()
		t.Fatal("Open succeeded with the wrong password; the URL password is not being used")
	}
}
