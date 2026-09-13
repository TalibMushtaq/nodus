-- ============================================================
-- Nodus Relay — audit #22: signed per-shard hash snapshot staging
-- ============================================================
--
-- The node stores device-signed per-shard hashes (FILE_SHARD_MANIFEST) and now
-- carries them in rebuild snapshots so a relay rebuilt from scratch preserves
-- the authenticated hashes alongside the versions that reference them.
CREATE TABLE IF NOT EXISTS file_version_shard_hashes (
    file_id          TEXT        NOT NULL,
    version_number   INTEGER     NOT NULL,
    shard_index      INTEGER     NOT NULL,
    shard_hash       TEXT        NOT NULL,
    PRIMARY KEY (file_id, version_number, shard_index),
    FOREIGN KEY (file_id, version_number)
        REFERENCES file_versions(file_id, version_number) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS rebuild_file_version_shard_hashes (
    account_id       TEXT        NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
    file_id          TEXT        NOT NULL,
    version_number   INTEGER     NOT NULL,
    shard_index      INTEGER     NOT NULL,
    shard_hash       TEXT        NOT NULL,
    PRIMARY KEY (account_id, file_id, version_number, shard_index)
);
