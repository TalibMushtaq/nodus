-- ============================================================
-- Nodus Relay — Phase 14 F2c: key-envelope snapshot staging
-- ============================================================
--
-- Envelopes are now carried in node snapshots, so a full rebuild replaces the
-- account's live set from staged data instead of preserving it (§22's
-- "not in snapshot ≠ delete" no longer applies once they are snapshotted).
CREATE TABLE IF NOT EXISTS rebuild_key_envelopes (
    account_id       TEXT        NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
    file_id          TEXT        NOT NULL,
    recipient_id     TEXT        NOT NULL,
    recipient_kind   TEXT        NOT NULL CHECK (recipient_kind IN ('device', 'node')),
    encrypted_key    TEXT        NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (account_id, file_id, recipient_id)
);
