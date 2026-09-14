-- ============================================================
-- Nodus Relay — Node capacity + device presence (Overview)
-- ============================================================
--
-- The Overview page reports storage used/total per Storage Node and needs to
-- distinguish recently-active client devices. Neither figure was previously
-- persisted in Postgres: capacity lived only in the node's own SQLite
-- catalogue, and device liveness only in the in-memory hub / Redis presence
-- (which the browser cannot read). These columns let the Relay expose both
-- through the existing /nodes and /devices responses.

-- Storage capacity figures the node reports on each heartbeat. Defaults keep
-- pre-upgrade nodes at 0/0, which the web client treats as "unknown".
ALTER TABLE storage_nodes ADD COLUMN IF NOT EXISTS used_bytes  BIGINT NOT NULL DEFAULT 0;
ALTER TABLE storage_nodes ADD COLUMN IF NOT EXISTS total_bytes BIGINT NOT NULL DEFAULT 0;

-- Last time the device was observed (WS heartbeat / register). Nullable so
-- devices registered before this migration read as "unknown", not "now".
ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
