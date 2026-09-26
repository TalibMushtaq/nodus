package handler

import (
	"context"
	"log"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/TalibMushtaq/nodus/services/relay/internal/config"
	"github.com/TalibMushtaq/nodus/services/relay/internal/rdb"
	"github.com/redis/go-redis/v9"
)

// Bounds for the in-process bucket map. The map is keyed by client IP, and
// with TRUST_PROXY set the key derives from a header, so an attacker could
// otherwise force unbounded growth by varying that header.
const (
	defaultMaxBuckets = 100_000
	bucketIdleTTL     = 10 * time.Minute
	// sweepEvery rate-limits the O(n) idle sweep so a flood of new
	// attacker-controlled keys cannot force a full-map scan on every request.
	sweepEvery = time.Second
)

// ipRateLimiter is a minimal per-IP token-bucket rate limiter for the pairing
// code redeem endpoint. It is deliberately in-process (no Redis) — pairing
// attempts are infrequent and the burst cap is low enough that a process
// restart is harmless.
type ipRateLimiter struct {
	mu      sync.Mutex
	buckets map[string]*ipBucket
	burst   float64
	refill  float64 // tokens per second
	// maxBuckets bounds memory; bucketIdleTTL lets fully-idle buckets be swept.
	// Held as fields (not consts read directly) so tests can drive them small.
	maxBuckets int
	idleTTL    time.Duration
	// sweepEvery throttles the idle sweep; lastSweep is the previous sweep time.
	sweepEvery time.Duration
	lastSweep  time.Time
}

type ipBucket struct {
	tokens float64
	last   time.Time
}

func newIPRateLimiter(burst float64, refill float64) *ipRateLimiter {
	return &ipRateLimiter{
		buckets:    make(map[string]*ipBucket),
		burst:      burst,
		refill:     refill,
		maxBuckets: defaultMaxBuckets,
		idleTTL:    bucketIdleTTL,
		sweepEvery: sweepEvery,
	}
}

// Allow returns true if the caller (identified by IP) has at least one token.
func (rl *ipRateLimiter) Allow(ip string) bool {
	now := time.Now()
	rl.mu.Lock()
	defer rl.mu.Unlock()

	b, ok := rl.buckets[ip]
	if !ok {
		// Bound the map before admitting a new key. The idle sweep is throttled
		// to at most once per sweepEvery; if the map is still full after a scan
		// we fail closed (429) rather than evicting on every attacker-controlled
		// key, which would make each request O(n).
		if len(rl.buckets) >= rl.maxBuckets {
			if now.Sub(rl.lastSweep) >= rl.sweepEvery {
				rl.sweepIdleLocked(now)
				rl.lastSweep = now
			}
			if len(rl.buckets) >= rl.maxBuckets {
				return false
			}
		}
		b = &ipBucket{tokens: rl.burst - 1, last: now}
		rl.buckets[ip] = b
		return true
	}

	elapsed := now.Sub(b.last).Seconds()
	b.tokens += elapsed * rl.refill
	if b.tokens > rl.burst {
		b.tokens = rl.burst
	}
	b.last = now

	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

// sweepIdleLocked drops buckets that have not been seen for idleTTL. Caller
// holds rl.mu.
func (rl *ipRateLimiter) sweepIdleLocked(now time.Time) {
	for key, b := range rl.buckets {
		if now.Sub(b.last) >= rl.idleTTL {
			delete(rl.buckets, key)
		}
	}
}

// clientIP resolves the peer IP for rate limiting. The socket's RemoteAddr is
// "IP:port"; when the Relay sits behind the operator's TLS reverse proxy (plan
// §3b) RemoteAddr is the proxy itself, so with cfg.TrustProxy set we take the
// rightmost X-Forwarded-For entry — the value the trusted proxy appended. The
// leftmost entries are client-controlled and must never be trusted, or a client
// could prepend a fresh IP per request and bypass the per-IP limit entirely.
// If no parseable entry exists we fall back to the socket IP.
func clientIP(r *http.Request, cfg *config.Config) string {
	host := r.RemoteAddr
	if h, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		host = h
	}
	if cfg != nil && cfg.TrustProxy {
		if first := trustedForwardedIP(r.Header.Get("X-Forwarded-For")); first != "" {
			return first
		}
	}
	return host
}

// trustedForwardedIP returns the rightmost parseable X-Forwarded-For entry, or
// "" if none parse. Only a single trusted proxy hop is assumed; a deployment
// with multiple proxies would need an explicit trusted-hop count.
func trustedForwardedIP(xff string) string {
	parts := strings.Split(xff, ",")
	for i := len(parts) - 1; i >= 0; i-- {
		candidate := strings.TrimSpace(parts[i])
		if net.ParseIP(candidate) != nil {
			return candidate
		}
	}
	return ""
}

// allowTokenBucket is a token bucket that lives entirely inside Redis, so one
// limit applies to the whole deployment instead of resetting per process.
//
// The clock is Redis's own TIME rather than the caller's. A bucket is compared
// against a stored timestamp, so two instances with skewed clocks would each
// measure a different interval for the same key: one can hand out tokens the
// other believes do not exist yet, or hold a bucket drained for twice the
// intended window. Reading the server clock makes every instance measure the
// same elapsed time.
var allowTokenBucket = redis.NewScript(`
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)

local key = KEYS[1]
local burst = tonumber(ARGV[1])
local refill = tonumber(ARGV[2])

local state = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(state[1])
local ts = tonumber(state[2])
if tokens == nil or ts == nil then
	tokens = burst
	ts = now
end

-- Only a positive elapsed time adds tokens. A timestamp from the future (a
-- replica restoring a clock, an operator editing the key) must not mint them.
local elapsed = now - ts
if elapsed > 0 then
	tokens = math.min(burst, tokens + (elapsed / 1000) * refill)
end

local allowed = 0
if tokens >= 1 then
	tokens = tokens - 1
	allowed = 1
end

redis.call('HSET', key, 'tokens', tokens, 'ts', now)
-- Expire the key once the bucket would be full again, so an idle key deletes
-- itself. This is what bounds the key space without a sweeper: every key is
-- created by a request and gets a deadline in the same breath, so a caller
-- rotating source addresses cannot accumulate them.
redis.call('PEXPIRE', key, math.ceil((burst / refill) * 1000) + 1000)
return allowed
`)

// rateLimiter is the per-IP limiter the HTTP handlers use. With Redis reachable
// the bucket is shared by every relay instance; without it the limiter degrades
// to the in-process one, which still bounds the rate for a single instance.
type rateLimiter struct {
	name   string
	burst  float64
	refill float64
	rdb    *rdb.Client
	// local backs the limiter when Redis was never configured. The relay treats
	// Redis as optional — it starts, logs a warning and disables the features
	// that need it — so an endpoint behind this limiter cannot require it.
	local *ipRateLimiter
}

func newRateLimiter(rClient *rdb.Client, name string, burst, refill float64) *rateLimiter {
	return &rateLimiter{
		name:   name,
		burst:  burst,
		refill: refill,
		rdb:    rClient,
		local:  newIPRateLimiter(burst, refill),
	}
}

// Allow consumes one token for ip. A non-nil error means Redis was configured
// but could not be reached, which callers must not read as "allowed": the whole
// point of the shared bucket is that an instance cannot be used to get around a
// limit, and a broken backend is exactly when that pressure would show up.
func (rl *rateLimiter) Allow(ctx context.Context, ip string) (bool, error) {
	if rl.rdb == nil {
		return rl.local.Allow(ip), nil
	}
	key := "ratelimit:" + rl.name + ":" + ip
	allowed, err := allowTokenBucket.Run(ctx, rl.rdb.Client, []string{key}, rl.burst, rl.refill).Int64()
	if err != nil {
		return false, err
	}
	return allowed == 1, nil
}

// allowRequest applies rl to the request's client address, writing the response
// and returning false when the request should not proceed.
//
// A limiter that cannot be reached answers 503, not 429. The request was not
// over its limit, and telling a retrying client to back off for something it did
// not do would both stall it for no reason and disguise an infrastructure fault
// as client misbehaviour.
func allowRequest(w http.ResponseWriter, r *http.Request, cfg *config.Config, rl *rateLimiter) bool {
	// A nil limiter is a wiring mistake, and the two obvious ways to paper over
	// it are both wrong: skipping the check would turn the endpoint unbounded,
	// and panicking would drop the connection instead of answering. Fail closed
	// with the same answer as an unreachable backend, which is what it is.
	if rl == nil {
		log.Printf("[ratelimit] refusing request: no rate limiter configured")
		respondError(w, http.StatusServiceUnavailable, "rate_limit_unavailable")
		return false
	}
	ip := clientIP(r, cfg)
	allowed, err := rl.Allow(r.Context(), ip)
	if err != nil {
		log.Printf("[ratelimit] %s: backend unavailable for %s: %v", rl.name, ip, err)
		respondError(w, http.StatusServiceUnavailable, "rate_limit_unavailable")
		return false
	}
	if !allowed {
		respondError(w, http.StatusTooManyRequests, "rate_limit_exceeded")
		return false
	}
	return true
}
