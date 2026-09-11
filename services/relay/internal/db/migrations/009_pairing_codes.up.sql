-- ============================================================
-- Nodus Relay — Phase 7b: Pairing codes for self-hosted node bootstrap
-- ============================================================
--
-- One-time, short-lived codes (NODUS-XXXX-XXXX) that a Storage Node
-- redeems over HTTPS to register itself under the issuing account.
-- Only the SHA-256 hash is stored; plaintext is returned once and
-- never logged.

CREATE TABLE pairing_codes (
    code_hash   TEXT        NOT NULL PRIMARY KEY,
    account_id  TEXT        NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
    status      TEXT        NOT NULL DEFAULT 'PENDING',
    node_id     TEXT        REFERENCES storage_nodes(node_id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at  TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ
);

CREATE INDEX idx_pairing_codes_account ON pairing_codes(account_id);
