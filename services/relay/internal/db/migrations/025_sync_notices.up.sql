-- One row per (account, file, version) whose shards are all NODE_STORED, so a
-- "backup complete" notification is sent once per fully-synced version rather
-- than on every shard ack.
CREATE TABLE IF NOT EXISTS sync_notices (
    account_id     TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
    file_id        TEXT NOT NULL,
    version_number INTEGER NOT NULL,
    notified_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (account_id, file_id, version_number)
);
