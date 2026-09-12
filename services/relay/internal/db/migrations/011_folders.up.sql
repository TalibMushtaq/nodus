-- ============================================================
-- Nodus Relay — Phase 14 F1: Folder projection
-- ============================================================
--
-- Devices emit FOLDER_CREATED / FOLDER_DELETED sync events. Without a live
-- table they were journaled with no projection; without a staging table a
-- snapshot rebuild could not reconstruct the folder tree.

CREATE TABLE IF NOT EXISTS folders (
    folder_id        TEXT        NOT NULL PRIMARY KEY,
    account_id       TEXT        NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
    parent_folder_id TEXT,
    encrypted_name   TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_folders_account ON folders(account_id);

-- Snapshot staging, account-scoped like the other rebuild_* tables.
CREATE TABLE IF NOT EXISTS rebuild_folders (
    account_id       TEXT        NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
    folder_id        TEXT        NOT NULL,
    parent_folder_id TEXT,
    encrypted_name   TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (account_id, folder_id)
);
