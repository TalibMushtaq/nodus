-- ============================================================
-- Nodus Storage Node — Phase 11: Local discovery / pairing
-- ============================================================
--
-- Adds the trust-store columns needed by the local challenge-response
-- flow and a server-side pairing-session log that enforces single-use
-- redemption independently of the Relay's TTL (see
-- docs/security/local-endpoints.md).

-- Track when a device was paired to this node and last authenticated
-- locally, for the discovery UI and for revoking stale devices.
ALTER TABLE devices ADD COLUMN paired_at TEXT;
ALTER TABLE devices ADD COLUMN last_authenticated_at TEXT;

-- Relay-issued pairing tokens, pushed to the node over WS (fast path) or
-- verified lazily against the Relay (fallback). `consumed_at` enforces
-- single-use locally even if the Relay's own row were out of sync.
CREATE TABLE pairing_sessions (
    token                 TEXT NOT NULL PRIMARY KEY,
    -- Ed25519 public key the token was bound to at issuance (32 bytes).
    device_public_key     BLOB NOT NULL,
    -- Which node this token authorizes pairing for.
    node_id               TEXT NOT NULL,
    issued_at             TEXT NOT NULL,
    expires_at            TEXT NOT NULL,
    -- Set on first redemption; a second use must be rejected.
    consumed_at           TEXT
);

CREATE INDEX idx_pairing_sessions_node ON pairing_sessions (node_id, expires_at);
CREATE INDEX idx_pairing_sessions_consumed ON pairing_sessions (consumed_at);