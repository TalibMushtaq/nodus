package auth_test

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/TalibMushtaq/nodus/services/relay/internal/auth"
	"github.com/TalibMushtaq/nodus/services/relay/internal/config"
	"github.com/TalibMushtaq/nodus/services/relay/internal/db"
)

// sessionHarness binds a live Postgres pool + seeded account/device rows.
// Every field stays from one CreateSession unless noted otherwise.
type sessionHarness struct {
	ctx       context.Context
	cancel    context.CancelFunc
	pool      *db.Pool
	store     auth.SessionStore
	accountID string
	deviceID  string
}

func setupSessionHarness(t *testing.T) *sessionHarness {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set; skipping integration test")
	}

	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	if err := db.RunMigrations(url); err != nil {
		t.Fatalf("run migrations: %v", err)
	}
	pool, err := db.Open(ctx, &config.Config{DatabaseURL: url})
	if err != nil {
		t.Fatalf("open pool: %v", err)
	}
	t.Cleanup(pool.Close)

	cfg := &config.Config{
		SessionCookieName:    "nodus_session",
		SessionMaxAge:        30 * 24 * time.Hour,
		SessionTouchInterval: 30 * time.Minute,
	}

	h := &sessionHarness{
		ctx:       ctx,
		cancel:    cancel,
		pool:      pool,
		accountID: "acct-sessions",
		deviceID:  "dev-sessions",
	}
	h.store = auth.NewPGSessionStore(pool, cfg)

	for _, s := range []struct {
		q    string
		args []any
	}{
		{
			q:    `INSERT INTO accounts (account_id, email, password_hash) VALUES ($1, 'sessions@test.local', 'x') ON CONFLICT DO NOTHING`,
			args: []any{h.accountID},
		},
		{
			q:    `INSERT INTO devices (device_id, account_id, public_key) VALUES ($1, $2, 'deadbeef') ON CONFLICT DO NOTHING`,
			args: []any{h.deviceID, h.accountID},
		},
		// Re-activate the seeded device so tests run independently; a prior test
		// may have revoked it to exercise LookupSession's device-ACTIVE check.
		{
			q:    `UPDATE devices SET status = 'ACTIVE', revoked_at = NULL WHERE device_id = $1`,
			args: []any{h.deviceID},
		},
	} {
		_, err := pool.Exec(ctx, s.q, s.args...)
		require.NoError(t, err, "seed query failed: %s", s.q)
	}

	return h
}

func (h *sessionHarness) lastUsedAt(t *testing.T, rawID string) time.Time {
	t.Helper()
	var lu time.Time
	err := h.pool.QueryRow(h.ctx,
		`SELECT last_used_at FROM sessions WHERE session_hash = $1`, auth.HashSession(rawID),
	).Scan(&lu)
	require.NoError(t, err)
	return lu
}

func TestSessionCreateLookupHashOnly(t *testing.T) {
	h := setupSessionHarness(t)

	rawID, err := h.store.CreateSession(h.ctx, h.accountID, h.deviceID)
	require.NoError(t, err)

	sess, err := h.store.LookupSession(h.ctx, rawID)
	require.NoError(t, err)
	require.Equal(t, h.accountID, sess.AccountID)
	require.Equal(t, h.deviceID, sess.DeviceID)

	// Only the SHA-256 hash may be stored; the raw token must never appear.
	var storedHash string
	err = h.pool.QueryRow(h.ctx,
		`SELECT session_hash FROM sessions WHERE session_hash = $1`, auth.HashSession(rawID),
	).Scan(&storedHash)
	require.NoError(t, err, "expected a row keyed by the hash")
	require.Equal(t, auth.HashSession(rawID), storedHash)

	var rawStored bool
	err = h.pool.QueryRow(h.ctx,
		`SELECT EXISTS(SELECT 1 FROM sessions WHERE session_hash = $1)`, rawID,
	).Scan(&rawStored)
	require.NoError(t, err)
	require.False(t, rawStored, "raw session token must not be stored")
}

func TestSessionLookupExpired(t *testing.T) {
	h := setupSessionHarness(t)

	rawID, err := h.store.CreateSession(h.ctx, h.accountID, h.deviceID)
	require.NoError(t, err)

	_, err = h.pool.Exec(h.ctx,
		`UPDATE sessions SET expires_at = NOW() - INTERVAL '1 hour' WHERE session_hash = $1`,
		auth.HashSession(rawID))
	require.NoError(t, err)

	_, err = h.store.LookupSession(h.ctx, rawID)
	require.True(t, errors.Is(err, auth.ErrSessionInvalid), "expired session must be invalid")
}

func TestSessionLookupRevokedDevice(t *testing.T) {
	h := setupSessionHarness(t)

	rawID, err := h.store.CreateSession(h.ctx, h.accountID, h.deviceID)
	require.NoError(t, err)

	_, err = h.pool.Exec(h.ctx,
		`UPDATE devices SET status = 'REVOKED', revoked_at = NOW() WHERE device_id = $1`,
		h.deviceID)
	require.NoError(t, err)

	_, err = h.store.LookupSession(h.ctx, rawID)
	require.True(t, errors.Is(err, auth.ErrSessionInvalid), "session bound to revoked device must be invalid")
}

func TestSessionRevoke(t *testing.T) {
	h := setupSessionHarness(t)

	rawID, err := h.store.CreateSession(h.ctx, h.accountID, h.deviceID)
	require.NoError(t, err)

	require.NoError(t, h.store.RevokeSession(h.ctx, rawID))

	_, err = h.store.LookupSession(h.ctx, rawID)
	require.True(t, errors.Is(err, auth.ErrSessionInvalid), "revoked session must be invalid")
}

func TestSessionRevokeAllForAccountAndDevice(t *testing.T) {
	h := setupSessionHarness(t)

	// Second device for the account to isolate per-device revocation.
	otherDevice := "dev-sessions-2"
	_, err := h.pool.Exec(h.ctx,
		`INSERT INTO devices (device_id, account_id, public_key) VALUES ($1, $2, 'beefdead') ON CONFLICT DO NOTHING`,
		otherDevice, h.accountID)
	require.NoError(t, err)

	s1, err := h.store.CreateSession(h.ctx, h.accountID, h.deviceID)
	require.NoError(t, err)
	s2, err := h.store.CreateSession(h.ctx, h.accountID, h.deviceID)
	require.NoError(t, err)
	other, err := h.store.CreateSession(h.ctx, h.accountID, otherDevice)
	require.NoError(t, err)

	require.NoError(t, h.store.RevokeAllForDevice(h.ctx, h.deviceID))

	_, err = h.store.LookupSession(h.ctx, s1)
	require.True(t, errors.Is(err, auth.ErrSessionInvalid), "device-revoked session must be invalid")
	_, err = h.store.LookupSession(h.ctx, s2)
	require.True(t, errors.Is(err, auth.ErrSessionInvalid), "device-revoked session must be invalid")

	// Sessions of a different device survive.
	_, err = h.store.LookupSession(h.ctx, other)
	require.NoError(t, err)

	// Revoke-all-account kills everything including the surviving device.
	require.NoError(t, h.store.RevokeAllForAccount(h.ctx, h.accountID))
	_, err = h.store.LookupSession(h.ctx, other)
	require.True(t, errors.Is(err, auth.ErrSessionInvalid), "account-revoked session must be invalid")
}

func TestSessionCapRevokesOldest(t *testing.T) {
	h := setupSessionHarness(t)

	const cap = auth.MaxActiveSessionsPerAccount

	// Seed one session "in the past" so ordering is unambiguous.
	old := make([]string, 0, cap+1)
	for i := 0; i < cap+1; i++ {
		raw, err := h.store.CreateSession(h.ctx, h.accountID, h.deviceID)
		require.NoError(t, err)
		old = append(old, raw)
		if i == 0 {
			// Age the first session so it is the oldest created_at.
			_, err := h.pool.Exec(h.ctx,
				`UPDATE sessions SET created_at = NOW() - INTERVAL '1 hour' WHERE session_hash = $1`,
				auth.HashSession(raw))
			require.NoError(t, err)
		}
	}

	var active int
	err := h.pool.QueryRow(h.ctx,
		`SELECT COUNT(*) FROM sessions WHERE account_id = $1 AND revoked_at IS NULL`,
		h.accountID,
	).Scan(&active)
	require.NoError(t, err)
	require.Equal(t, cap, active, "11th session must evict the oldest")

	// The evicted (oldest) session is revoked and invalid.
	_, err = h.store.LookupSession(h.ctx, old[0])
	require.True(t, errors.Is(err, auth.ErrSessionInvalid), "oldest session must be revoked")
}

func TestSessionTouchThrottle(t *testing.T) {
	h := setupSessionHarness(t)

	rawID, err := h.store.CreateSession(h.ctx, h.accountID, h.deviceID)
	require.NoError(t, err)

	// Force last_used_at far enough in the past (49m) that a touch with a 30m
	// threshold must bump it.
	_, err = h.pool.Exec(h.ctx,
		`UPDATE sessions SET last_used_at = NOW() - INTERVAL '49 minutes' WHERE session_hash = $1`,
		auth.HashSession(rawID))
	require.NoError(t, err)
	require.NoError(t, h.store.TouchSession(h.ctx, rawID))
	require.True(t, time.Since(h.lastUsedAt(t, rawID)) < 10*time.Second, "touch must bump a stale last_used_at")

	// Now 10 minutes old — under the 30m threshold — touch must be a no-op.
	_, err = h.pool.Exec(h.ctx,
		`UPDATE sessions SET last_used_at = NOW() - INTERVAL '10 minutes' WHERE session_hash = $1`,
		auth.HashSession(rawID))
	require.NoError(t, err)
	before := h.lastUsedAt(t, rawID)
	require.NoError(t, h.store.TouchSession(h.ctx, rawID))
	require.True(t, h.lastUsedAt(t, rawID).Equal(before), "touch must not bump within the throttle window")
}
