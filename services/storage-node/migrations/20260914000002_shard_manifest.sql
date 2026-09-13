-- ============================================================
-- Nodus Storage Node — Phase 10: signed per-shard manifests (audit #22)
-- ============================================================
--
-- A device that uploads a file encrypts it shard-by-shard and later publishes a
-- `FILE_SHARD_MANIFEST` event asserting the BLAKE3 hash of every packed shard,
-- signed with its paired Ed25519 key. The node stores the authenticated hashes
-- here and refuses to record a Relay- or peer-supplied shard whose bytes do not
-- match — closing the "compromised Relay plants the first copy" gap that
-- content-addressing alone cannot.

CREATE TABLE IF NOT EXISTS file_version_shard_hashes (
    file_id         TEXT    NOT NULL,
    version_number  INTEGER NOT NULL,
    shard_index     INTEGER NOT NULL,
    shard_hash      TEXT    NOT NULL,
    PRIMARY KEY (file_id, version_number, shard_index)
);

CREATE INDEX IF NOT EXISTS idx_shard_hashes_version
    ON file_version_shard_hashes (file_id, version_number);
