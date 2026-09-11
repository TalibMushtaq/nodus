package handler

import (
	"fmt"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/TalibMushtaq/nodus/services/relay/internal/config"
)

func TestClientIPStripsPort(t *testing.T) {
	r := httptest.NewRequest("POST", "/pairing/codes/redeem", nil)
	r.RemoteAddr = "203.0.113.7:443"
	require.Equal(t, "203.0.113.7", clientIP(r, &config.Config{}))
}

func TestClientIPIPv6(t *testing.T) {
	r := httptest.NewRequest("POST", "/pairing/codes/redeem", nil)
	r.RemoteAddr = "[2001:db8::1]:9999"
	require.Equal(t, "2001:db8::1", clientIP(r, &config.Config{}))
}

func TestClientIPBareHost(t *testing.T) {
	r := httptest.NewRequest("POST", "/pairing/codes/redeem", nil)
	r.RemoteAddr = "203.0.113.7"
	require.Equal(t, "203.0.113.7", clientIP(r, &config.Config{}))
}

func TestClientIPIgnoresXFFByDefault(t *testing.T) {
	r := httptest.NewRequest("POST", "/pairing/codes/redeem", nil)
	r.RemoteAddr = "203.0.113.7:443"
	r.Header.Set("X-Forwarded-For", "198.51.100.9, 10.0.0.1")
	require.Equal(t, "203.0.113.7", clientIP(r, &config.Config{TrustProxy: false}))
}

func TestClientIPTakesRightmostXFFWhenTrusted(t *testing.T) {
	r := httptest.NewRequest("POST", "/pairing/codes/redeem", nil)
	r.RemoteAddr = "10.0.0.1:443"
	r.Header.Set("X-Forwarded-For", "198.51.100.9, 10.0.0.1")
	require.Equal(t, "10.0.0.1", clientIP(r, &config.Config{TrustProxy: true}),
		"must use the value appended by the trusted proxy, not a client-supplied leftmost entry")
}

func TestClientIPIgnoresSpoofedLeftmostXFF(t *testing.T) {
	// A client prepends its own value; Caddy appends the real peer. Taking the
	// leftmost entry would let the client rotate buckets per request.
	r := httptest.NewRequest("POST", "/pairing/codes/redeem", nil)
	r.RemoteAddr = "10.0.0.1:443"
	r.Header.Set("X-Forwarded-For", "1.2.3.4, 203.0.113.9")
	require.Equal(t, "203.0.113.9", clientIP(r, &config.Config{TrustProxy: true}))
}

func TestClientIPFallsBackOnBadXFF(t *testing.T) {
	r := httptest.NewRequest("POST", "/pairing/codes/redeem", nil)
	r.RemoteAddr = "10.0.0.1:443"
	r.Header.Set("X-Forwarded-For", "not-an-ip, 10.0.0.1")
	require.Equal(t, "10.0.0.1", clientIP(r, &config.Config{TrustProxy: true}))
}

func TestClientIPNilConfig(t *testing.T) {
	r := httptest.NewRequest("POST", "/pairing/codes/redeem", nil)
	r.RemoteAddr = "203.0.113.7:443"
	r.Header.Set("X-Forwarded-For", "198.51.100.9")
	require.Equal(t, "203.0.113.7", clientIP(r, nil))
}

func TestRateLimiterBoundsBuckets(t *testing.T) {
	rl := newIPRateLimiter(10, 2)
	rl.maxBuckets = 3
	rl.idleTTL = time.Hour    // nothing is idle
	rl.sweepEvery = time.Hour // disable the sweep so capacity alone bounds the map

	admitted := 0
	for i := 0; i < 50; i++ {
		if rl.Allow(fmt.Sprintf("10.0.0.%d", i)) {
			admitted++
		}
	}

	rl.mu.Lock()
	require.LessOrEqual(t, len(rl.buckets), 3, "bucket map must stay bounded")
	rl.mu.Unlock()
	require.Equal(t, 3, admitted, "keys beyond capacity must fail closed, not evict")
}

func TestRateLimiterSweepsIdleBuckets(t *testing.T) {
	rl := newIPRateLimiter(10, 2)
	rl.maxBuckets = 2
	rl.idleTTL = time.Millisecond
	rl.sweepEvery = 0 // allow a sweep on every admission attempt

	require.True(t, rl.Allow("10.0.0.1"))
	require.True(t, rl.Allow("10.0.0.2"))
	time.Sleep(5 * time.Millisecond)
	// Admitting a third key at capacity triggers the idle sweep.
	require.True(t, rl.Allow("10.0.0.3"))

	rl.mu.Lock()
	_, stale := rl.buckets["10.0.0.1"]
	require.False(t, stale, "idle bucket should have been swept")
	require.LessOrEqual(t, len(rl.buckets), 2)
	rl.mu.Unlock()
}
