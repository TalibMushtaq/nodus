-- ============================================================
-- Nodus Storage Node — Initial SQLite Schema (Phase 5)
-- ============================================================
--
-- Run at first boot by sqlx::migrate! before any other DB work.
-- All timestamps are stored as ISO 8601 UTC strings (TEXT) so
-- they are human-readable and portable across SQLite tools.
-- Foreign-key enforcement is enabled per connection in db.rs.
-- WAL mode is set per connection in db.rs (cannot be in CREATE).
--

-- ── File catalogue ──────────────────────────────────────────

CREATE TABLE files (
    file_id          TEXT NOT NULL PRIMARY KEY,
    parent_folder_id TEXT,
    -- Encrypted, opaque to the node; the client holds the key.
    encrypted_name   TEXT,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL
);

CREATE TABLE file_versions (
    file_id           TEXT    NOT NULL,
    version_number    INTEGER NOT NULL,
    parent_version_id INTEGER,
    -- BLAKE3 hash of the assembled plaintext version (for reconciliation).
    version_hash      TEXT    NOT NULL,
    shard_count       INTEGER NOT NULL,
    created_at        TEXT    NOT NULL,
    PRIMARY KEY (file_id, version_number),
    FOREIGN KEY (file_id) REFERENCES files(file_id) ON DELETE CASCADE
);

CREATE INDEX idx_file_versions_parent ON file_versions (file_id, parent_version_id);

-- ── Object store index ──────────────────────────────────────
--
-- storage_objects tracks the physical encrypted blobs in
-- <data_dir>/objects/<prefix>/<hash>. The shard table links
-- logical shards to their physical objects.

CREATE TABLE storage_objects (
    -- BLAKE3 hex hash of the encrypted shard bytes (content-addressed).
    object_id       TEXT NOT NULL PRIMARY KEY,
    size_bytes      INTEGER NOT NULL,
    -- 'PENDING' | 'STORED' | 'DEGRADED' | 'PERMANENTLY_MISSING'
    status          TEXT NOT NULL DEFAULT 'PENDING',
    created_at      TEXT NOT NULL
);

CREATE TABLE shards (
    file_id         TEXT    NOT NULL,
    version_number  INTEGER NOT NULL,
    shard_index     INTEGER NOT NULL,
    object_id       TEXT    NOT NULL,
    -- Size of the encrypted shard (before decryption).
    size_bytes      INTEGER NOT NULL,
    PRIMARY KEY (file_id, version_number, shard_index),
    FOREIGN KEY (file_id, version_number)
        REFERENCES file_versions(file_id, version_number) ON DELETE CASCADE,
    FOREIGN KEY (object_id)
        REFERENCES storage_objects(object_id)
);

-- ── Identity / trust ────────────────────────────────────────

CREATE TABLE devices (
    device_id        TEXT NOT NULL PRIMARY KEY,
    -- Raw Ed25519 public key bytes (32 bytes).
    public_key_bytes BLOB NOT NULL,
    -- 'ACTIVE' | 'REVOKED'
    status           TEXT NOT NULL DEFAULT 'ACTIVE',
    created_at       TEXT NOT NULL,
    revoked_at       TEXT
);

CREATE TABLE trusted_nodes (
    node_id          TEXT NOT NULL PRIMARY KEY,
    public_key_bytes BLOB NOT NULL,
    created_at       TEXT NOT NULL
);

-- ── Event log & sync ────────────────────────────────────────
--
-- sync_events is the durable append-only event log.
-- UNIQUE on (origin_id, origin_sequence) enforces idempotency:
-- re-delivering an already-applied event is a no-op.

CREATE TABLE sync_events (
    event_id        TEXT    NOT NULL PRIMARY KEY,
    origin_id       TEXT    NOT NULL,
    origin_sequence INTEGER NOT NULL,
    event_type      TEXT    NOT NULL,
    -- JSON-encoded payload; structure defined in packages/protocol.
    payload         TEXT    NOT NULL,
    timestamp       TEXT    NOT NULL,
    UNIQUE (origin_id, origin_sequence)
);

-- Index to support cursor-based sync draining (Phase 8):
--   SELECT … WHERE origin_id = ? AND origin_sequence > ?
CREATE INDEX idx_sync_events_origin ON sync_events (origin_id, origin_sequence);

-- sync_outbox: denormalized queue of events that this node has
-- produced and needs to push to the Relay. Keeps full event data
-- inline (matching §15) so the drain path needs no JOIN.
-- 'synced' is set to 1 once the Relay has acknowledged the event;
-- a background job sweeps synced rows after a grace period.
CREATE TABLE sync_outbox (
    event_id        TEXT    NOT NULL PRIMARY KEY,
    origin_id       TEXT    NOT NULL,
    origin_sequence INTEGER NOT NULL,
    event_type      TEXT    NOT NULL,
    payload         TEXT    NOT NULL,
    created_at      TEXT    NOT NULL,
    -- 0 = pending, 1 = relay has acknowledged
    synced          INTEGER NOT NULL DEFAULT 0
);

-- sync_cursors: tracks the highest sequence number seen per peer,
-- enabling the SYNC_HELLO / SYNC_STATUS handshake (§18).
CREATE TABLE sync_cursors (
    -- peer_id is a node_id or device_id or 'relay'
    peer_id            TEXT    NOT NULL PRIMARY KEY,
    last_sequence_seen INTEGER NOT NULL,
    updated_at         TEXT    NOT NULL
);

-- ── Tombstones ───────────────────────────────────────────────
--
-- Represents a logical deletion (§17). Retained for the GC window
-- (default 90 days, §29a) to prevent resurrection by long-offline devices.

CREATE TABLE tombstones (
    entity_type     TEXT NOT NULL,  -- 'file' | 'folder'
    entity_id       TEXT NOT NULL,
    deleted_at      TEXT NOT NULL,
    PRIMARY KEY (entity_type, entity_id)
);
