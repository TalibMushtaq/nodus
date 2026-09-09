-- ============================================================
-- Nodus Relay — Phase 7a: opaque server-side sessions
-- ============================================================
--
-- Replaces the JWT/refresh-token auth model (Todo.md Phase 7a §1, plan §13):
-- account auth is now an opaque, randomly generated session token handed to
-- the client exactly once as an HttpOnly cookie. PostgreSQL stores only the
-- SHA-256 hash (sessions.session_hash), never the raw token.
--
-- refresh_tokens is dropped outright — pre-production, no migration window,
-- no dual auth model. Every session is bound to a registered device.

CREATE TABLE sessions (
    session_id    UUID        NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
    session_hash  TEXT        NOT NULL UNIQUE,
    account_id    TEXT        NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
    device_id     TEXT        NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at    TIMESTAMPTZ NOT NULL,
    last_used_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at    TIMESTAMPTZ
);

-- Lookups: authenticating each request by session_hash, and the
-- max-10-active-sessions eviction scan keyed on account.
CREATE INDEX idx_sessions_account ON sessions(account_id);

-- "Revoke all sessions for a device" on device revocation.
CREATE INDEX idx_sessions_device ON sessions(device_id);

-- Old JWT/refresh rows are incompatible with the new model and are removed.
DROP TABLE refresh_tokens;