-- ============================================================
-- Nodus Relay — recovery challenge nonces (ADR-0002)
-- ============================================================
--
-- Online recovery authenticates with a signature from the account recovery key
-- rather than a password. The Relay issues a single-use, short-lived nonce so a
-- captured signature cannot be replayed. Persisted (not in-memory) so recovery
-- works across Relay instances.

CREATE TABLE IF NOT EXISTS recovery_challenges (
    nonce      TEXT        NOT NULL PRIMARY KEY,
    account_id TEXT        NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at    TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_recovery_challenges_account ON recovery_challenges(account_id);
