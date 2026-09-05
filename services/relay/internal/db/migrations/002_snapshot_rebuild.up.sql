-- ============================================================
-- Nodus Relay — Phase 9: Full Snapshot / Relay Rebuild
-- ============================================================

-- ── Primary node designation ────────────────────────────────────────
-- v1: the first Storage Node paired to an account is primary automatically;
-- every subsequent node for the account defaults to is_primary = false.
ALTER TABLE storage_nodes ADD COLUMN IF NOT EXISTS is_primary BOOLEAN NOT NULL DEFAULT false;

-- ── Rebuild request queue ───────────────────────────────────────────
-- Persists pending rebuild requests so they survive a Relay restart and are
-- delivered to the primary node when it comes online. Only the account's
-- primary node may serve a rebuild; we wait rather than falling back.
CREATE TABLE IF NOT EXISTS rebuild_requests (
    id               BIGSERIAL    PRIMARY KEY,
    account_id       TEXT         NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
    node_id          TEXT         NOT NULL REFERENCES storage_nodes(node_id) ON DELETE CASCADE,
    reason           TEXT         NOT NULL DEFAULT 'admin',
    status           TEXT         NOT NULL DEFAULT 'pending', -- 'pending' | 'delivered' | 'failed'
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    delivered_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_rebuild_requests_account ON rebuild_requests(account_id, status);

-- ── Staging tables (rebuild_*) for snapshot promotion ───────────────
-- Snapshot data is staged here during transfer and only atomically swapped
-- into the live tables after full verification succeeds, so a failed/aborted
-- rebuild never leaves the Relay in a half-rebuilt state. Mirrors the live
-- files / file_versions / tombstones projections (account-scoped).
CREATE TABLE IF NOT EXISTS rebuild_files (
    file_id          TEXT        NOT NULL PRIMARY KEY,
    account_id       TEXT        NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
    parent_folder_id TEXT,
    encrypted_name   TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS rebuild_file_versions (
    file_id           TEXT        NOT NULL,
    account_id        TEXT        NOT NULL,
    version_number    INTEGER     NOT NULL,
    parent_version_id INTEGER,
    conflict_status   TEXT        NOT NULL DEFAULT 'none' CHECK (conflict_status IN ('none', 'flagged', 'resolved')),
    version_hash      TEXT        NOT NULL,
    shard_count       INTEGER     NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (file_id, version_number)
);

CREATE INDEX IF NOT EXISTS idx_rebuild_file_versions_account ON rebuild_file_versions(account_id);

-- Only tombstones newer than the 90-day retention window (ADR-0005) are
-- required in a snapshot; older ones may be omitted since they're pruned.
CREATE TABLE IF NOT EXISTS rebuild_tombstones (
    account_id       TEXT        NOT NULL,
    entity_type      TEXT        NOT NULL,
    entity_id        TEXT        NOT NULL,
    deleted_at       TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (account_id, entity_type, entity_id)
);
