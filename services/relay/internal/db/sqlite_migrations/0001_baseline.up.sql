-- SQLite baseline schema for the Nodus Relay.
--
-- This is a clean single-migration baseline, not a translation of the 31
-- PostgreSQL migrations (those remain in history). Type mapping:
--   text / uuid / jsonb            -> TEXT
--   integer / bigint / boolean     -> INTEGER
--   timestamp with time zone       -> INTEGER (unix milliseconds, UTC)
-- Timestamp columns default to unixepoch('subsec') * 1000, so an INSERT that
-- omits a timestamp behaves like the PostgreSQL DEFAULT now(). Queries that use
-- NOW() are served by a now() scalar the driver registers (see sqlite.go).
-- Tables are STRICT so a value of the wrong type fails instead of being
-- coerced, which recovers the type enforcement the bundle of SQLite defaults
-- would otherwise lose.

CREATE TABLE accounts (
    account_id          TEXT    NOT NULL PRIMARY KEY,
    email               TEXT    NOT NULL UNIQUE,
    password_hash       TEXT    NOT NULL,
    created_at          INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
    recovery_public_key TEXT
) STRICT;

CREATE TABLE storage_nodes (
    node_id                        TEXT    NOT NULL PRIMARY KEY,
    account_id                     TEXT    NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
    public_key                     TEXT    NOT NULL,
    capabilities                   TEXT    NOT NULL DEFAULT '[]',
    status                         TEXT    NOT NULL DEFAULT 'ACTIVE',
    last_seen_at                   INTEGER,
    created_at                     INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
    is_primary                     INTEGER NOT NULL DEFAULT 0,
    display_name                   TEXT,
    used_bytes                     INTEGER NOT NULL DEFAULT 0,
    total_bytes                    INTEGER NOT NULL DEFAULT 0,
    last_promoted_snapshot_sequence INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX idx_nodes_account ON storage_nodes(account_id);
CREATE UNIQUE INDEX idx_storage_nodes_one_primary ON storage_nodes(account_id) WHERE is_primary;

CREATE TABLE devices (
    device_id            TEXT    NOT NULL PRIMARY KEY,
    account_id           TEXT    NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
    public_key           TEXT    NOT NULL,
    status               TEXT    NOT NULL DEFAULT 'ACTIVE',
    created_at           INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
    revoked_at           INTEGER,
    display_name         TEXT,
    last_seen_at         INTEGER,
    encryption_public_key TEXT,
    platform             TEXT,
    os_version           TEXT,
    browser              TEXT,
    app_version          TEXT,
    user_agent           TEXT
) STRICT;
CREATE INDEX idx_devices_account ON devices(account_id);

CREATE TABLE folders (
    folder_id        TEXT    NOT NULL PRIMARY KEY,
    account_id       TEXT    NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
    parent_folder_id TEXT,
    encrypted_name   TEXT,
    created_at       INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
    updated_at       INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
) STRICT;
CREATE INDEX idx_folders_account ON folders(account_id);

CREATE TABLE files (
    file_id          TEXT    NOT NULL PRIMARY KEY,
    account_id       TEXT    NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
    parent_folder_id TEXT,
    encrypted_name   TEXT,
    created_at       INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
    updated_at       INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
    preferred_version INTEGER
) STRICT;
CREATE INDEX idx_files_account ON files(account_id);

CREATE TABLE file_versions (
    file_id           TEXT    NOT NULL REFERENCES files(file_id) ON DELETE CASCADE,
    version_number    INTEGER NOT NULL,
    parent_version_id INTEGER,
    conflict_status   TEXT    NOT NULL DEFAULT 'none' CHECK (conflict_status IN ('none', 'flagged', 'resolved')),
    version_hash      TEXT    NOT NULL,
    shard_count       INTEGER NOT NULL,
    created_at        INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
    conflicted_name   TEXT,
    PRIMARY KEY (file_id, version_number)
) STRICT;
CREATE INDEX idx_file_versions_parent ON file_versions(file_id, parent_version_id);

CREATE TABLE file_version_shard_hashes (
    file_id        TEXT    NOT NULL,
    version_number INTEGER NOT NULL,
    shard_index    INTEGER NOT NULL,
    shard_hash     TEXT    NOT NULL,
    PRIMARY KEY (file_id, version_number, shard_index),
    FOREIGN KEY (file_id, version_number) REFERENCES file_versions(file_id, version_number) ON DELETE CASCADE
) STRICT;

CREATE TABLE file_locations (
    file_id        TEXT    NOT NULL,
    version_number INTEGER NOT NULL,
    shard_index    INTEGER NOT NULL,
    node_id        TEXT    NOT NULL REFERENCES storage_nodes(node_id) ON DELETE CASCADE,
    status         TEXT    NOT NULL DEFAULT 'RELAY_BUFFERED',
    buffer_id      TEXT,
    updated_at     INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
    hash           TEXT,
    size_bytes     INTEGER,
    source_device  TEXT,
    PRIMARY KEY (file_id, version_number, shard_index, node_id),
    FOREIGN KEY (file_id, version_number) REFERENCES file_versions(file_id, version_number) ON DELETE CASCADE
) STRICT;
CREATE INDEX idx_file_locations_node_status ON file_locations(node_id, status);

CREATE TABLE folder_key_envelopes (
    folder_id      TEXT    NOT NULL REFERENCES folders(folder_id) ON DELETE CASCADE,
    recipient_id   TEXT    NOT NULL,
    recipient_kind TEXT    NOT NULL CHECK (recipient_kind IN ('device', 'node', 'recovery')),
    encrypted_key  TEXT    NOT NULL,
    created_at     INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
    PRIMARY KEY (folder_id, recipient_id)
) STRICT;
CREATE INDEX idx_folder_key_envelopes_recipient ON folder_key_envelopes(recipient_id);

CREATE TABLE key_envelopes (
    file_id        TEXT    NOT NULL REFERENCES files(file_id) ON DELETE CASCADE,
    recipient_id   TEXT    NOT NULL,
    encrypted_key  TEXT    NOT NULL,
    created_at     INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
    recipient_kind TEXT    NOT NULL DEFAULT 'device' CHECK (recipient_kind IN ('device', 'node', 'recovery')),
    PRIMARY KEY (file_id, recipient_id)
) STRICT;

CREATE TABLE pairing_codes (
    code_hash  TEXT    NOT NULL PRIMARY KEY,
    account_id TEXT    NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
    status     TEXT    NOT NULL DEFAULT 'PENDING',
    node_id    TEXT    REFERENCES storage_nodes(node_id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
    expires_at INTEGER NOT NULL,
    consumed_at INTEGER
) STRICT;
CREATE INDEX idx_pairing_codes_account ON pairing_codes(account_id);

CREATE TABLE pairing_sessions (
    id                TEXT    NOT NULL PRIMARY KEY,
    account_id        TEXT    NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
    node_id           TEXT    NOT NULL REFERENCES storage_nodes(node_id) ON DELETE CASCADE,
    device_id         TEXT    NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
    device_public_key TEXT    NOT NULL,
    token             TEXT    NOT NULL UNIQUE,
    status            TEXT    NOT NULL DEFAULT 'ACTIVE',
    created_at        INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
    consumed_at       INTEGER,
    expires_at        INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_pairing_sessions_account ON pairing_sessions(account_id);
CREATE INDEX idx_pairing_sessions_node ON pairing_sessions(node_id);

CREATE TABLE push_tokens (
    device_id             TEXT    NOT NULL PRIMARY KEY REFERENCES devices(device_id) ON DELETE CASCADE,
    account_id            TEXT    NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
    token                 TEXT    NOT NULL,
    platform              TEXT    NOT NULL,
    notify_conflicts      INTEGER NOT NULL DEFAULT 1,
    notify_device_offline INTEGER NOT NULL DEFAULT 1,
    notify_sync_complete  INTEGER NOT NULL DEFAULT 1,
    created_at            INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
    updated_at            INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
) STRICT;
CREATE INDEX idx_push_tokens_account ON push_tokens(account_id);

CREATE TABLE rebuild_files (
    file_id          TEXT    NOT NULL,
    account_id       TEXT    NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
    parent_folder_id TEXT,
    encrypted_name   TEXT,
    created_at       INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
    updated_at       INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
    PRIMARY KEY (account_id, file_id)
) STRICT;
CREATE INDEX idx_rebuild_files_account ON rebuild_files(account_id);

CREATE TABLE rebuild_file_versions (
    file_id           TEXT    NOT NULL,
    account_id        TEXT    NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
    version_number    INTEGER NOT NULL,
    parent_version_id INTEGER,
    conflict_status   TEXT    NOT NULL DEFAULT 'none' CHECK (conflict_status IN ('none', 'flagged', 'resolved')),
    version_hash      TEXT    NOT NULL,
    shard_count       INTEGER NOT NULL,
    created_at        INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
    conflicted_name   TEXT,
    PRIMARY KEY (account_id, file_id, version_number)
) STRICT;
CREATE INDEX idx_rebuild_file_versions_account ON rebuild_file_versions(account_id);

CREATE TABLE rebuild_file_version_shard_hashes (
    account_id     TEXT    NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
    file_id        TEXT    NOT NULL,
    version_number INTEGER NOT NULL,
    shard_index    INTEGER NOT NULL,
    shard_hash     TEXT    NOT NULL,
    PRIMARY KEY (account_id, file_id, version_number, shard_index)
) STRICT;

CREATE TABLE rebuild_folders (
    account_id       TEXT    NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
    folder_id        TEXT    NOT NULL,
    parent_folder_id TEXT,
    encrypted_name   TEXT,
    created_at       INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
    PRIMARY KEY (account_id, folder_id)
) STRICT;

CREATE TABLE rebuild_folder_key_envelopes (
    account_id     TEXT    NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
    folder_id      TEXT    NOT NULL,
    recipient_id   TEXT    NOT NULL,
    recipient_kind TEXT    NOT NULL CHECK (recipient_kind IN ('device', 'node', 'recovery')),
    encrypted_key  TEXT    NOT NULL,
    created_at     INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
    PRIMARY KEY (account_id, folder_id, recipient_id)
) STRICT;

CREATE TABLE rebuild_key_envelopes (
    account_id     TEXT    NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
    file_id        TEXT    NOT NULL,
    recipient_id   TEXT    NOT NULL,
    recipient_kind TEXT    NOT NULL CHECK (recipient_kind IN ('device', 'node', 'recovery')),
    encrypted_key  TEXT    NOT NULL,
    created_at     INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
    PRIMARY KEY (account_id, file_id, recipient_id)
) STRICT;

CREATE TABLE rebuild_tombstones (
    account_id  TEXT    NOT NULL,
    entity_type TEXT    NOT NULL,
    entity_id   TEXT    NOT NULL,
    deleted_at  INTEGER NOT NULL,
    PRIMARY KEY (account_id, entity_type, entity_id)
) STRICT;

CREATE TABLE rebuild_activities (
    account_id  TEXT    NOT NULL,
    activity_id TEXT    NOT NULL,
    origin_id   TEXT    NOT NULL,
    kind        TEXT    NOT NULL,
    outcome     TEXT    NOT NULL,
    file_id     TEXT,
    path        TEXT,
    detail      TEXT,
    created_at  INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
    PRIMARY KEY (account_id, activity_id)
) STRICT;

CREATE TABLE rebuild_requests (
    id           INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    account_id   TEXT    NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
    node_id      TEXT    NOT NULL REFERENCES storage_nodes(node_id) ON DELETE CASCADE,
    reason       TEXT    NOT NULL DEFAULT 'admin',
    status       TEXT    NOT NULL DEFAULT 'pending',
    created_at   INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
    delivered_at INTEGER
) STRICT;
CREATE INDEX idx_rebuild_requests_account ON rebuild_requests(account_id, status);

CREATE TABLE recovery_challenges (
    nonce      TEXT    NOT NULL PRIMARY KEY,
    account_id TEXT    NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    used_at    INTEGER,
    created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
) STRICT;
CREATE INDEX idx_recovery_challenges_account ON recovery_challenges(account_id);

CREATE TABLE sessions (
    session_id   TEXT    NOT NULL PRIMARY KEY,
    session_hash TEXT    NOT NULL UNIQUE,
    account_id   TEXT    NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
    device_id    TEXT    NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
    created_at   INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
    expires_at   INTEGER NOT NULL,
    last_used_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
    revoked_at   INTEGER
) STRICT;
CREATE INDEX idx_sessions_account ON sessions(account_id);
CREATE INDEX idx_sessions_device ON sessions(device_id);

CREATE TABLE sync_cursors (
    account_id    TEXT    NOT NULL,
    peer_id       TEXT    NOT NULL,
    last_sequence INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
    PRIMARY KEY (account_id, peer_id)
) STRICT;

CREATE TABLE sync_events (
    event_id        TEXT    NOT NULL PRIMARY KEY,
    account_id      TEXT    NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
    origin_id       TEXT    NOT NULL,
    origin_sequence INTEGER NOT NULL,
    event_type      TEXT    NOT NULL,
    payload         TEXT    NOT NULL,
    "timestamp"     INTEGER NOT NULL,
    UNIQUE (account_id, origin_id, origin_sequence)
) STRICT;
CREATE INDEX idx_sync_events_account ON sync_events(account_id, "timestamp");
CREATE INDEX idx_sync_events_origin ON sync_events(origin_id, origin_sequence);

CREATE TABLE sync_notices (
    account_id     TEXT    NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
    file_id        TEXT    NOT NULL,
    version_number INTEGER NOT NULL,
    notified_at    INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
    PRIMARY KEY (account_id, file_id, version_number)
) STRICT;

CREATE TABLE tombstone_node_status (
    account_id  TEXT    NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
    entity_type TEXT    NOT NULL,
    entity_id   TEXT    NOT NULL,
    node_id     TEXT    NOT NULL,
    deleted_at  INTEGER,
    purged_at   INTEGER,
    PRIMARY KEY (account_id, entity_type, entity_id, node_id)
) STRICT;
CREATE INDEX idx_tombstone_node_status_entity ON tombstone_node_status(account_id, entity_type, entity_id);

CREATE TABLE tombstones (
    account_id         TEXT    NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
    entity_type        TEXT    NOT NULL,
    entity_id          TEXT    NOT NULL,
    deleted_at         INTEGER NOT NULL,
    purge_after        INTEGER NOT NULL,
    purge_requested_at INTEGER,
    PRIMARY KEY (account_id, entity_type, entity_id)
) STRICT;

CREATE TABLE web_push_subscriptions (
    endpoint              TEXT    NOT NULL PRIMARY KEY,
    account_id            TEXT    NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
    p256dh                TEXT    NOT NULL,
    auth                  TEXT    NOT NULL,
    notify_conflicts      INTEGER NOT NULL DEFAULT 1,
    notify_device_offline INTEGER NOT NULL DEFAULT 1,
    notify_sync_complete  INTEGER NOT NULL DEFAULT 1,
    created_at            INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
    updated_at            INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
) STRICT;
CREATE INDEX idx_web_push_account ON web_push_subscriptions(account_id);

CREATE TABLE activities (
    account_id  TEXT    NOT NULL,
    activity_id TEXT    NOT NULL,
    origin_id   TEXT    NOT NULL,
    kind        TEXT    NOT NULL,
    outcome     TEXT    NOT NULL,
    file_id     TEXT,
    path        TEXT,
    detail      TEXT,
    created_at  INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
    PRIMARY KEY (account_id, activity_id)
) STRICT;
CREATE INDEX idx_activities_account_created ON activities(account_id, created_at DESC);

CREATE TABLE conflict_notices (
    account_id  TEXT    NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
    file_id     TEXT    NOT NULL,
    notified_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
    PRIMARY KEY (account_id, file_id)
) STRICT;
