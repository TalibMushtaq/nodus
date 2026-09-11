package handler

import (
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/TalibMushtaq/nodus/services/relay/internal/config"
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

var redeemLimiter = newIPRateLimiter(10, 2)
