package handler

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/require"

	"github.com/TalibMushtaq/nodus/services/relay/internal/config"
	"github.com/TalibMushtaq/nodus/services/relay/internal/rdb"
)

// testRedis opens the integration Redis, or skips. Limiter names below are
// derived from the test name, so each test gets its own key space and no test
// can be handed a bucket another one already drained.
func testRedis(t *testing.T) *rdb.Client {
	t.Helper()
	url := os.Getenv("TEST_REDIS_URL")
	if url == "" {
		t.Skip("TEST_REDIS_URL not set; skipping Redis rate limiter test")
	}
	client, err := rdb.Open(context.Background(), &config.Config{RedisURL: url})
	require.NoError(t, err)
	t.Cleanup(func() { _ = client.Close() })
	return client
}

// testLimiterName namespaces a limiter under the running test.
func testLimiterName(t *testing.T) string {
	return "test_" + strings.NewReplacer("/", "_", " ", "_").Replace(t.Name())
}

// TestRedisLimiterSharesBucketsAcrossInstances is the point of putting the
// bucket in Redis. With an in-process limiter each replica started with a full
// burst, so a caller that reached a second instance got the allowance again —
// which is what a load balancer arranges for free, and what an attacker
// arranges on purpose.
func TestRedisLimiterSharesBucketsAcrossInstances(t *testing.T) {
	client := testRedis(t)
	name := testLimiterName(t)
	const burst = 5

	first := newRateLimiter(client, name, burst, 0.1)
	second := newRateLimiter(client, name, burst, 0.1)
	const ip = "203.0.113.9"

	for i := range burst {
		allowed, err := first.Allow(context.Background(), ip)
		require.NoError(t, err)
		require.True(t, allowed, "request %d should be inside the burst", i)
	}

	// The bucket is empty. A second instance pointed at the same Redis must see
	// that, not a fresh one.
	for i := range 3 {
		allowed, err := second.Allow(context.Background(), ip)
		require.NoError(t, err)
		require.False(t, allowed,
			"instance two granted request %d after instance one drained the bucket", i)
	}
}

// TestRedisLimiterRefillsOverTime covers the other half of a token bucket: a
// limit that never refills is an outage, not a rate limit.
func TestRedisLimiterRefillsOverTime(t *testing.T) {
	client := testRedis(t)
	rl := newRateLimiter(client, testLimiterName(t), 2, 20) // one token per 50ms
	const ip = "203.0.113.10"

	for range 2 {
		allowed, err := rl.Allow(context.Background(), ip)
		require.NoError(t, err)
		require.True(t, allowed)
	}
	allowed, err := rl.Allow(context.Background(), ip)
	require.NoError(t, err)
	require.False(t, allowed, "the bucket should be empty")

	time.Sleep(150 * time.Millisecond) // ~3 tokens at 20/s

	allowed, err = rl.Allow(context.Background(), ip)
	require.NoError(t, err)
	require.True(t, allowed, "the bucket should have refilled")
}

// TestRedisLimiterSeparatesIPs guards the obvious way a shared key space could
// go wrong: one noisy caller draining everyone else's allowance.
func TestRedisLimiterSeparatesIPs(t *testing.T) {
	rl := newRateLimiter(testRedis(t), testLimiterName(t), 2, 0.1)

	for range 3 {
		rl.Allow(context.Background(), "198.51.100.1") //nolint:errcheck // outcome asserted below
	}
	allowed, err := rl.Allow(context.Background(), "198.51.100.1")
	require.NoError(t, err)
	require.False(t, allowed, "the noisy address should be limited")

	allowed, err = rl.Allow(context.Background(), "198.51.100.2")
	require.NoError(t, err)
	require.True(t, allowed, "a different address must not inherit the drained bucket")
}

// TestRedisLimiterSeparatesEndpoints checks the limiter name is part of the key.
// The two recovery endpoints share a budget on purpose; two unrelated endpoints
// must not.
func TestRedisLimiterSeparatesEndpoints(t *testing.T) {
	client := testRedis(t)
	const ip = "203.0.113.12"

	challenge := newRateLimiter(client, testLimiterName(t)+"_challenge", 1, 0.1)
	recover := newRateLimiter(client, testLimiterName(t)+"_recover", 1, 0.1)

	allowed, err := challenge.Allow(context.Background(), ip)
	require.NoError(t, err)
	require.True(t, allowed)
	allowed, err = challenge.Allow(context.Background(), ip)
	require.NoError(t, err)
	require.False(t, allowed)

	allowed, err = recover.Allow(context.Background(), ip)
	require.NoError(t, err)
	require.True(t, allowed, "a different endpoint has its own budget")
}

// TestLimiterDegradesWhenRedisIsAbsent covers the deployment where Redis is
// never configured at all — the relay starts and logs a warning in that case, so
// an endpoint may not assume it. The limit is then per-process and weaker, which
// is the honest trade: something bounded, rather than nothing or a 503 for every
// pairing attempt.
func TestLimiterDegradesWhenRedisIsAbsent(t *testing.T) {
	rl := newRateLimiter(nil, testLimiterName(t), 2, 0.1)
	const ip = "203.0.113.13"

	for range 2 {
		allowed, err := rl.Allow(context.Background(), ip)
		require.NoError(t, err, "no Redis configured is not an error")
		require.True(t, allowed)
	}
	allowed, err := rl.Allow(context.Background(), ip)
	require.NoError(t, err)
	require.False(t, allowed, "the in-process fallback must still bound the rate")
}

// TestLimiterReportsBackendError pins the third state. When Redis is configured
// but unreachable, Allow must return an error rather than a quiet "allowed" —
// reporting allowed would turn a broken backend into unlimited attempts, which
// is the exact moment the limit matters most.
func TestLimiterReportsBackendError(t *testing.T) {
	dead := &rdb.Client{Client: redis.NewClient(&redis.Options{
		Addr: "127.0.0.1:1", // nothing listens here
		// No retries: a rate limiter that blocks for the default backoff would
		// hold the request open long enough to be its own outage.
		MaxRetries:   -1,
		DialTimeout:  50 * time.Millisecond,
		ReadTimeout:  50 * time.Millisecond,
		WriteTimeout: 50 * time.Millisecond,
	})}
	t.Cleanup(func() { _ = dead.Close() })

	rl := newRateLimiter(dead, testLimiterName(t), 10, 2)
	allowed, err := rl.Allow(context.Background(), "203.0.113.14")
	require.Error(t, err, "an unreachable Redis must be reported, not silently allowed")
	require.False(t, allowed)
}

// TestOpenEndpointAnswersUnavailableWhenLimiterIsDown is the handler half of the
// same decision, and the reason it is a 503 and not a 429: the caller did not
// exceed anything. A 429 would tell a retrying client to back off for a
// misbehaviour it did not commit, and would hide the fault from an operator.
func TestOpenEndpointAnswersUnavailableWhenLimiterIsDown(t *testing.T) {
	dead := &rdb.Client{Client: redis.NewClient(&redis.Options{
		Addr: "127.0.0.1:1", MaxRetries: -1,
		DialTimeout: 50 * time.Millisecond, ReadTimeout: 50 * time.Millisecond,
		WriteTimeout: 50 * time.Millisecond,
	})}
	t.Cleanup(func() { _ = dead.Close() })

	cfg := &config.Config{}
	// Both recovery handlers take the same limiter, as main wires them.
	deadRecovery := NewRecoveryLimiter(dead)
	for name, handler := range map[string]http.HandlerFunc{
		"pairing session verify": VerifyPairingSession(nil, cfg, dead),
		"node url verify":        VerifyNodeURL(nil, cfg, dead),
		"pairing code redeem":    RedeemPairingCode(nil, cfg, dead),
		"recovery challenge":     RecoveryChallenge(nil, cfg, deadRecovery),
		"recover":                Recover(nil, nil, cfg, deadRecovery),
	} {
		t.Run(name, func(t *testing.T) {
			req := httptest.NewRequest("GET", "/nodes/verify?node_id=n-1", nil)
			req.RemoteAddr = "203.0.113.15:1234"
			rr := httptest.NewRecorder()
			handler(rr, req)
			require.Equal(t, http.StatusServiceUnavailable, rr.Code,
				"a broken limiter is an infrastructure fault, not a client over its limit")
		})
	}
}
