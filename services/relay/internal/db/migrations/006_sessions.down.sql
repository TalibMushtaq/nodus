-- ============================================================
-- Nodus Relay — Phase 7a: roll back sessions to refresh_tokens
-- ============================================================

DROP TABLE IF EXISTS sessions;

-- Restore the legacy refresh-token table (original 001_initial shape) so the
-- down migration is reversible.
CREATE TABLE refresh_tokens (
    token_id     TEXT        NOT NULL PRIMARY KEY,
    account_id   TEXT        NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
    token_hash   TEXT        NOT NULL UNIQUE,
    device_id    TEXT,
    expires_at   TIMESTAMPTZ NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at   TIMESTAMPTZ
);
CREATE INDEX idx_refresh_tokens_account ON refresh_tokens(account_id);