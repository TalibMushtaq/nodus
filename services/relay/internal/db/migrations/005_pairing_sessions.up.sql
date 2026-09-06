-- ============================================================
-- Nodus Relay — Phase 11: Pairing sessions
-- ============================================================
--
-- Relay-issued, device-bound, single-use tokens that a web/mobile client
-- presents directly to the Storage Node's local HTTP listener (/nodus/pair).
-- The node redeems locally (fast path, token pushed over WS) or falls back
-- to POST /pairing/sessions/verify on this table.
--
-- The token is bound to the *registered* device public key at creation time
-- (the key is read from the devices table, not trusted from the request
-- body), so a sniffed token cannot be redeemed by an attacker who does not
-- control the corresponding private key.

CREATE TABLE pairing_sessions (
    id                UUID        NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id        TEXT        NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
    node_id           TEXT        NOT NULL REFERENCES storage_nodes(node_id) ON DELETE CASCADE,
    device_id         TEXT        NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
    device_public_key TEXT        NOT NULL,
    token             TEXT        NOT NULL UNIQUE,
    status            TEXT        NOT NULL DEFAULT 'ACTIVE',
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    consumed_at       TIMESTAMPTZ,
    expires_at        TIMESTAMPTZ NOT NULL
);

-- Fast lookups: verify-by-token (node fallback) and push-delivery to a node.
CREATE INDEX idx_pairing_sessions_token    ON pairing_sessions(token);
CREATE INDEX idx_pairing_sessions_node     ON pairing_sessions(node_id);
CREATE INDEX idx_pairing_sessions_account  ON pairing_sessions(account_id);