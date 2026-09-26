package handler

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/TalibMushtaq/nodus/services/relay/internal/auth"
	"github.com/TalibMushtaq/nodus/services/relay/internal/config"
	"github.com/TalibMushtaq/nodus/services/relay/internal/db"
)

func testRecoveryConfig() *config.Config {
	return &config.Config{
		SessionCookieName:    "nodus_session",
		SessionMaxAge:        30 * 24 * time.Hour,
		SessionTouchInterval: 30 * time.Minute,
		SessionCookieSecure:  false,
	}
}

// enrollRecoveryTestKey attaches a fresh Ed25519 keypair to the harness account
// as if a trusted device had enrolled it, returning the public key, its private
// half for signing, and the base64 encoding stored on the account.
func enrollRecoveryTestKey(t *testing.T, pool *db.Pool, accountID string) ([]byte, ed25519.PrivateKey, string) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	require.NoError(t, err)
	encoded := base64.StdEncoding.EncodeToString(pub)
	_, err = pool.Exec(context.Background(),
		"UPDATE accounts SET recovery_public_key = $1 WHERE account_id = $2",
		encoded, accountID)
	require.NoError(t, err)
	return pub, priv, encoded
}

// Online recovery (ADR-0002) must accept a signature from the enrolled recovery
// key, mint a session, and refuse replay of a consumed nonce.
func TestRecoverWithSignedChallenge(t *testing.T) {
	pool, accountID := createPairingCodeHarness(t)

	_, priv, encodedKey := enrollRecoveryTestKey(t, pool, accountID)
	email := accountID + "@test.local"

	cfg := testRecoveryConfig()
	store := auth.NewPGSessionStore(pool, cfg)

	challengeBody, _ := json.Marshal(RecoveryChallengeRequest{Email: email})
	chRR := httptest.NewRecorder()
	RecoveryChallenge(pool, cfg, NewRecoveryLimiter(nil))(chRR, httptest.NewRequest("POST", "/auth/recovery/challenge", bytes.NewReader(challengeBody)))
	require.Equal(t, http.StatusOK, chRR.Code)

	var challenge RecoveryChallengeResponse
	require.NoError(t, json.Unmarshal(chRR.Body.Bytes(), &challenge))
	require.NotEmpty(t, challenge.Nonce)
	require.Equal(t, encodedKey, challenge.RecoveryPublicKey)

	recoverBody, _ := json.Marshal(RecoverRequest{
		Email:           email,
		Nonce:           challenge.Nonce,
		Signature:       hex.EncodeToString(ed25519.Sign(priv, []byte(challenge.Nonce))),
		DeviceID:        "recovered-device-" + accountID,
		DevicePublicKey: encodedKey,
	})
	rr := httptest.NewRecorder()
	Recover(pool, store, cfg, NewRecoveryLimiter(nil))(rr, httptest.NewRequest("POST", "/auth/recovery", bytes.NewReader(recoverBody)))
	require.Equal(t, http.StatusOK, rr.Code)

	// The nonce is single-use: replaying it (even with the same valid signature)
	// must fail after the first attempt consumed it.
	replayRR := httptest.NewRecorder()
	Recover(pool, store, cfg, NewRecoveryLimiter(nil))(replayRR, httptest.NewRequest("POST", "/auth/recovery", bytes.NewReader(recoverBody)))
	require.Equal(t, http.StatusUnauthorized, replayRR.Code)
}

// A wrong signature must be rejected AND leave the nonce usable: the claim is
// atomic, so a client typo cannot burn its own challenge.
func TestRecoverKeepsNonceAfterRejectedAttempt(t *testing.T) {
	pool, accountID := createPairingCodeHarness(t)

	_, priv, encodedKey := enrollRecoveryTestKey(t, pool, accountID)
	email := accountID + "@test.local"

	cfg := testRecoveryConfig()
	store := auth.NewPGSessionStore(pool, cfg)

	challengeBody, _ := json.Marshal(RecoveryChallengeRequest{Email: email})
	chRR := httptest.NewRecorder()
	RecoveryChallenge(pool, cfg, NewRecoveryLimiter(nil))(chRR, httptest.NewRequest("POST", "/auth/recovery/challenge", bytes.NewReader(challengeBody)))
	require.Equal(t, http.StatusOK, chRR.Code)
	var challenge RecoveryChallengeResponse
	require.NoError(t, json.Unmarshal(chRR.Body.Bytes(), &challenge))

	_, otherPriv, err := ed25519.GenerateKey(rand.Reader)
	require.NoError(t, err)

	recoveryAttempt := func(signKey ed25519.PrivateKey, deviceID string) *httptest.ResponseRecorder {
		body, _ := json.Marshal(RecoverRequest{
			Email:           email,
			Nonce:           challenge.Nonce,
			Signature:       hex.EncodeToString(ed25519.Sign(signKey, []byte(challenge.Nonce))),
			DeviceID:        deviceID,
			DevicePublicKey: encodedKey,
		})
		rr := httptest.NewRecorder()
		Recover(pool, store, cfg, NewRecoveryLimiter(nil))(rr, httptest.NewRequest("POST", "/auth/recovery", bytes.NewReader(body)))
		return rr
	}

	require.Equal(t, http.StatusUnauthorized, recoveryAttempt(otherPriv, "bad-sig-"+accountID).Code)

	// The same nonce is still valid with the correct signature, and no device
	// was registered for the rejected attempt.
	var deviceCount int
	err = pool.QueryRow(context.Background(),
		"SELECT COUNT(*) FROM devices WHERE account_id = $1", accountID,
	).Scan(&deviceCount)
	require.NoError(t, err)
	require.Zero(t, deviceCount)

	require.Equal(t, http.StatusOK, recoveryAttempt(priv, "good-sig-"+accountID).Code)
}

// TestRecoveryEndpointsShareOneLimiterWithoutRedis pins that the two recovery
// endpoints draw on a single budget when Redis is not configured.
//
// This regressed once: the limiter used to be a package-level global, and when
// it moved to Redis-backed buckets each handler started building its own. With
// Redis present the bug was invisible — both hit the same `ratelimit:recovery:`
// key — so it only showed in exactly the configuration this test uses. The
// recovery flow is two steps of one thing; alternating between them must not buy
// a second budget.
func TestRecoveryEndpointsShareOneLimiterWithoutRedis(t *testing.T) {
	pool, accountID := createPairingCodeHarness(t)
	cfg := testRecoveryConfig()
	store := auth.NewPGSessionStore(pool, cfg)

	// One limiter, wired to both handlers, as main does.
	limiter := NewRecoveryLimiter(nil)
	challenge := RecoveryChallenge(pool, cfg, limiter)
	recover := Recover(pool, store, cfg, limiter)

	email := accountID + "@test.local"
	challengeBody, err := json.Marshal(RecoveryChallengeRequest{Email: email})
	require.NoError(t, err)
	recoverBody, err := json.Marshal(RecoverRequest{Email: email, Nonce: "n", Signature: "s"})
	require.NoError(t, err)

	post := func(h http.HandlerFunc, path string, body []byte) int {
		req := httptest.NewRequest("POST", path, bytes.NewReader(body))
		req.RemoteAddr = "203.0.113.77:4321" // one client, so one bucket
		rr := httptest.NewRecorder()
		h(rr, req)
		return rr.Code
	}

	// Drain the shared budget on the challenge endpoint alone. The bodies are
	// not valid recovery attempts, so these answer 401/400 — the point is that
	// the limiter admitted them.
	for range recoveryBurst {
		require.NotEqual(t, http.StatusTooManyRequests,
			post(challenge, "/auth/recovery/challenge", challengeBody),
			"the shared budget should admit a full burst")
	}

	// Both endpoints are now spent. If the limiter were per-handler, the
	// recovery endpoint would still have its own burst.
	require.Equal(t, http.StatusTooManyRequests,
		post(challenge, "/auth/recovery/challenge", challengeBody),
		"the challenge endpoint is over its burst")
	require.Equal(t, http.StatusTooManyRequests,
		post(recover, "/auth/recovery", recoverBody),
		"the recovery endpoint drew on the same budget and must be limited too")
}

// TestNilRateLimiterFailsClosed covers the wiring mistake the shared limiter
// makes possible. Skipping the check would leave the endpoint unbounded and
// panicking would drop the connection; the honest answer is the same 503 an
// unreachable backend gets, because that is what a missing limiter is.
func TestNilRateLimiterFailsClosed(t *testing.T) {
	cfg := testRecoveryConfig()
	pool, _ := createPairingCodeHarness(t)

	req := httptest.NewRequest("POST", "/auth/recovery/challenge", bytes.NewReader([]byte(`{}`)))
	req.RemoteAddr = "203.0.113.78:4321"
	rr := httptest.NewRecorder()
	RecoveryChallenge(pool, cfg, nil)(rr, req)
	require.Equal(t, http.StatusServiceUnavailable, rr.Code)
	require.Contains(t, rr.Body.String(), "rate_limit_unavailable")
}
