-- ============================================================
-- Nodus Relay — Initial PostgreSQL Schema (Phase 7)
-- ============================================================

-- ── Accounts ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS accounts (
    account_id    TEXT        NOT NULL PRIMARY KEY,
    email         TEXT        NOT NULL UNIQUE,
    password_hash TEXT        NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Refresh Tokens ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS refresh_tokens (
    token_id     TEXT        NOT NULL PRIMARY KEY,
    account_id   TEXT        NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
    token_hash   TEXT        NOT NULL UNIQUE,
    device_id    TEXT,
    expires_at   TIMESTAMPTZ NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_account ON refresh_tokens(account_id);

-- ── Devices ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS devices (
    device_id        TEXT        NOT NULL PRIMARY KEY,
    account_id       TEXT        NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
    public_key       TEXT        NOT NULL,
    status           TEXT        NOT NULL DEFAULT 'ACTIVE',
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_devices_account ON devices(account_id);

-- ── Storage Nodes ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS storage_nodes (
    node_id          TEXT        NOT NULL PRIMARY KEY,
    account_id       TEXT        NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
    public_key       TEXT        NOT NULL,
    capabilities     JSONB       NOT NULL DEFAULT '[]'::jsonb,
    status           TEXT        NOT NULL DEFAULT 'ACTIVE',
    last_seen_at     TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_nodes_account ON storage_nodes(account_id);

-- ── File Catalogue ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS files (
    file_id          TEXT        NOT NULL PRIMARY KEY,
    account_id       TEXT        NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
    parent_folder_id TEXT,
    encrypted_name   TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_files_account ON files(account_id);

CREATE TABLE IF NOT EXISTS file_versions (
    file_id          TEXT        NOT NULL REFERENCES files(file_id) ON DELETE CASCADE,
    version_number   INTEGER     NOT NULL,
    version_hash     TEXT        NOT NULL,
    shard_count      INTEGER     NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (file_id, version_number)
);

-- ── File Shard Locations ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS file_locations (
    file_id          TEXT        NOT NULL,
    version_number   INTEGER     NOT NULL,
    shard_index      INTEGER     NOT NULL,
    node_id          TEXT        NOT NULL REFERENCES storage_nodes(node_id) ON DELETE CASCADE,
    status           TEXT        NOT NULL DEFAULT 'RELAY_BUFFERED',
    buffer_id        TEXT,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (file_id, version_number, shard_index, node_id),
    FOREIGN KEY (file_id, version_number)
        REFERENCES file_versions(file_id, version_number) ON DELETE CASCADE
);

-- ── Key Envelopes (§25) ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS key_envelopes (
    file_id          TEXT        NOT NULL REFERENCES files(file_id) ON DELETE CASCADE,
    recipient_id     TEXT        NOT NULL,
    encrypted_key    TEXT        NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (file_id, recipient_id)
);

-- ── Sync Events ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sync_events (
    event_id         TEXT        NOT NULL PRIMARY KEY,
    account_id       TEXT        NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
    origin_id        TEXT        NOT NULL,
    origin_sequence  BIGINT      NOT NULL,
    event_type       TEXT        NOT NULL,
    payload          JSONB       NOT NULL,
    timestamp        TIMESTAMPTZ NOT NULL,
    UNIQUE (origin_id, origin_sequence)
);
CREATE INDEX IF NOT EXISTS idx_sync_events_origin ON sync_events(origin_id, origin_sequence);
CREATE INDEX IF NOT EXISTS idx_sync_events_account ON sync_events(account_id, timestamp);

-- ── Sync Cursors ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sync_cursors (
    account_id       TEXT        NOT NULL,
    peer_id          TEXT        NOT NULL,
    last_sequence    BIGINT      NOT NULL,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (account_id, peer_id)
);

-- ── Tombstones ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tombstones (
    account_id       TEXT        NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
    entity_type      TEXT        NOT NULL,
    entity_id        TEXT        NOT NULL,
    deleted_at       TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (account_id, entity_type, entity_id)
);
