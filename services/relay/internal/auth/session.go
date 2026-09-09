package auth

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/TalibMushtaq/nodus/services/relay/internal/config"
	"github.com/TalibMushtaq/nodus/services/relay/internal/db"
)

// MaxActiveSessionsPerAccount is the hard cap from plan §13: issuing the 11th
// active session revokes the oldest.
const MaxActiveSessionsPerAccount = 10

// ErrSessionInvalid is returned by LookupSession when a raw token is missing,
// revoked, expired, or bound to a non-ACTIVE device. Handlers translate it to
// HTTP 401 without distinguishing the cause.
var ErrSessionInvalid = errors.New("invalid or expired session")

// Session is the server-side representation of an active login. The raw token
// is never part of this struct; session_hash is derived from it and kept in
// PostgreSQL only.
type Session struct {
	AccountID  string
	DeviceID   string
	ExpiresAt  time.Time
	LastUsedAt time.Time
}

// SessionStore is the persistence boundary for account sessions. Middleware and
// handlers depend on this interface so cookie/auth logic is unit-testable with
// a fake instead of a live PostgreSQL.
type SessionStore interface {
	CreateSession(ctx context.Context, accountID, deviceID string) (rawID string, err error)
	LookupSession(ctx context.Context, rawID string) (*Session, error)
	TouchSession(ctx context.Context, rawID string) error
	RevokeSession(ctx context.Context, rawID string) error
	RevokeAllForAccount(ctx context.Context, accountID string) error
	RevokeAllForDevice(ctx context.Context, deviceID string) error
	RotateSession(ctx context.Context, oldRawID, accountID, deviceID string) (newRawID string, err error)
}

// PGSessionStore persists sessions in PostgreSQL. Only SHA-256 hashes of raw
// session tokens are stored (phase 7a migration 006 drops refresh_tokens).
type PGSessionStore struct {
	pool *db.Pool
	cfg  *config.Config
}

// NewPGSessionStore wires a session store to the Relay's connection pool.
func NewPGSessionStore(pool *db.Pool, cfg *config.Config) *PGSessionStore {
	return &PGSessionStore{pool: pool, cfg: cfg}
}

// CreateSession mints a fresh opaque session token for the account/device pair,
// stores only its hash, and enforces the max-10-active-sessions cap inside the
// same transaction. The raw token is returned exactly once to be set as a
// cookie; it is never stored or logged.
func (s *PGSessionStore) CreateSession(ctx context.Context, accountID, deviceID string) (string, error) {
	rawID, err := GenerateSessionID()
	if err != nil {
		return "", err
	}
	now := time.Now().UTC()
	expiresAt := now.Add(s.cfg.SessionMaxAge)

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx) // nolint:errcheck

	if _, err := tx.Exec(ctx, `
		INSERT INTO sessions (session_hash, account_id, device_id, expires_at, last_used_at)
		VALUES ($1, $2, $3, $4, $5)
	`, HashSession(rawID), accountID, deviceID, expiresAt, now); err != nil {
		return "", fmt.Errorf("inserting session: %w", err)
	}

	// Cap active sessions at 10: revoke every active row for this account that
	// is not among the 10 most recently created.
	if _, err := tx.Exec(ctx, `
		UPDATE sessions SET revoked_at = $1
		WHERE account_id = $2 AND revoked_at IS NULL
		  AND session_hash IN (
			SELECT session_hash FROM sessions
			WHERE account_id = $2 AND revoked_at IS NULL
			ORDER BY created_at DESC OFFSET $3
		  )
	`, now, accountID, MaxActiveSessionsPerAccount); err != nil {
		return "", fmt.Errorf("enforcing session cap: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return "", err
	}

	return rawID, nil
}

// LookupSession resolves a raw session token. A session is valid only while it
// is unrevoked, unexpired, and bound to an ACTIVE device; any violation maps to
// ErrSessionInvalid (a single 401 surface for middleware/handlers).
func (s *PGSessionStore) LookupSession(ctx context.Context, rawID string) (*Session, error) {
	var (
		sess     Session
		revoked  *time.Time
		devState string
	)
	err := s.pool.QueryRow(ctx, `
		SELECT sess.account_id, sess.device_id, sess.expires_at, sess.last_used_at,
		       sess.revoked_at, dev.status
		FROM sessions sess
		JOIN devices dev ON dev.device_id = sess.device_id
		WHERE sess.session_hash = $1
	`, HashSession(rawID)).Scan(&sess.AccountID, &sess.DeviceID, &sess.ExpiresAt, &sess.LastUsedAt, &revoked, &devState)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrSessionInvalid
	}
	if err != nil {
		return nil, err
	}
	if revoked != nil || devState != "ACTIVE" || !time.Now().UTC().Before(sess.ExpiresAt) {
		return nil, ErrSessionInvalid
	}
	return &sess, nil
}

// TouchSession bumps last_used_at but never more than once per
// SessionTouchInterval per session — the conditional predicate makes the
// no-op case a zero-row UPDATE instead of a write on every request. This is a
// write-amplification optimization, not an idle timeout.
func (s *PGSessionStore) TouchSession(ctx context.Context, rawID string) error {
	now := time.Now().UTC()
	minLastUsed := now.Add(-s.cfg.SessionTouchInterval)
	_, err := s.pool.Exec(ctx, `
		UPDATE sessions SET last_used_at = $1
		WHERE session_hash = $2 AND last_used_at < $3
	`, now, HashSession(rawID), minLastUsed)
	return err
}

// RevokeSession invalidates a single session immediately by its raw token.
func (s *PGSessionStore) RevokeSession(ctx context.Context, rawID string) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE sessions SET revoked_at = $1
		WHERE session_hash = $2 AND revoked_at IS NULL
	`, time.Now().UTC(), HashSession(rawID))
	return err
}

// RevokeAllForAccount invalidates every active session for an account (e.g.
// "log out everywhere").
func (s *PGSessionStore) RevokeAllForAccount(ctx context.Context, accountID string) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE sessions SET revoked_at = $1
		WHERE account_id = $2 AND revoked_at IS NULL
	`, time.Now().UTC(), accountID)
	return err
}

// RevokeAllForDevice invalidates every active session bound to a device so a
// revoked/compromised device cannot keep an authenticated session alive.
func (s *PGSessionStore) RevokeAllForDevice(ctx context.Context, deviceID string) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE sessions SET revoked_at = $1
		WHERE device_id = $2 AND revoked_at IS NULL
	`, time.Now().UTC(), deviceID)
	return err
}

// RotateSession issues a replacement session for the same account/device and
// revokes the previous one in the same transaction — the session-fixation
// primitive for a credential change. The old raw token fails LookupSession
// immediately after commit; the revocation is scoped to the caller's own
// account/device so a stale cookie can never revoke somebody else's session.
func (s *PGSessionStore) RotateSession(ctx context.Context, oldRawID, accountID, deviceID string) (string, error) {
	newRawID, err := GenerateSessionID()
	if err != nil {
		return "", err
	}
	now := time.Now().UTC()
	expiresAt := now.Add(s.cfg.SessionMaxAge)

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx) // nolint:errcheck

	if _, err := tx.Exec(ctx, `
		INSERT INTO sessions (session_hash, account_id, device_id, expires_at, last_used_at)
		VALUES ($1, $2, $3, $4, $5)
	`, HashSession(newRawID), accountID, deviceID, expiresAt, now); err != nil {
		return "", fmt.Errorf("inserting rotated session: %w", err)
	}

	tag, err := tx.Exec(ctx, `
		UPDATE sessions SET revoked_at = $1
		WHERE session_hash = $2 AND account_id = $3 AND device_id = $4 AND revoked_at IS NULL
	`, now, HashSession(oldRawID), accountID, deviceID)
	if err != nil {
		return "", fmt.Errorf("revoking old session: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return "", ErrSessionInvalid
	}

	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return newRawID, nil
}
