-- ============================================================
-- Nodus Storage Node — Phase 10: Pending shard fetches
-- ============================================================
--
-- Holds shards that have been fetched from the Relay buffer but whose
-- file_versions row has not yet arrived via sync events. When the
-- FILE_VERSION_ADDED event is applied, matching rows are drained into
-- the shards table and removed here.

CREATE TABLE IF NOT EXISTS pending_shard_fetches (
    file_id         TEXT    NOT NULL,
    version_number  INTEGER NOT NULL,
    shard_index     INTEGER NOT NULL,
    object_id       TEXT    NOT NULL,
    size_bytes      INTEGER NOT NULL,
    fetched_at      TEXT    NOT NULL,
    PRIMARY KEY (file_id, version_number, shard_index)
);
