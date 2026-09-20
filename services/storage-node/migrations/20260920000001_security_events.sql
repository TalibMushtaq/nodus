-- ============================================================
-- Nodus Storage Node — security events (WebRTC download authorization)
-- ============================================================
--
-- A durable audit trail for security-relevant decisions the node makes that
-- are not errors worth failing a transfer over. The first producer is the
-- WebRTC shard-fetch path: a paired device may pull a shard it knows the hash
-- of even when the node has not yet synced that device's key envelope, so the
-- transfer proceeds but the gap is recorded here for review.
--
-- `id` is deterministic for dedupable events (e.g. one row per device+file
-- missing an envelope), so a many-shard download does not write a row per
-- shard; `INSERT OR IGNORE` on the primary key keeps it to one.

CREATE TABLE IF NOT EXISTS security_events (
    id          TEXT PRIMARY KEY,
    event_type  TEXT NOT NULL,
    device_id   TEXT,
    file_id     TEXT,
    detail      TEXT,
    created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_security_events_created
    ON security_events (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_security_events_type
    ON security_events (event_type);
