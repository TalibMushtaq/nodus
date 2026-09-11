package handler

import (
	"sync"
	"time"
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
}

type ipBucket struct {
	tokens float64
	last   time.Time
}

func newIPRateLimiter(burst float64, refill float64) *ipRateLimiter {
	return &ipRateLimiter{
		buckets: make(map[string]*ipBucket),
		burst:   burst,
		refill:  refill,
	}
}

// Allow returns true if the caller (identified by IP) has at least one token.
func (rl *ipRateLimiter) Allow(ip string) bool {
	now := time.Now()
	rl.mu.Lock()
	defer rl.mu.Unlock()

	b, ok := rl.buckets[ip]
	if !ok {
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

// ponytail: no sweep goroutine. Map stays tiny (one entry per unique IP that
// attempts pairing) and entries are cheap. Add a periodic sweep if memory
// matters.

var redeemLimiter = newIPRateLimiter(10, 2)
