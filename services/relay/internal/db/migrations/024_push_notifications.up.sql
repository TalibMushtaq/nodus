-- Push notification delivery (Phase 3).
--
-- `push_tokens` holds one Expo push token per registered device, with the
-- per-category opt-outs mirrored from the client's notification preferences so
-- the Relay can honour them when fanning out.
--
-- Notifications carry generic copy only: file names are encrypted (ADR-0001),
-- so a payload must never include a decrypted name.
CREATE TABLE IF NOT EXISTS push_tokens (
    device_id             TEXT PRIMARY KEY REFERENCES devices(device_id) ON DELETE CASCADE,
    account_id            TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
    token                 TEXT NOT NULL,
    platform              TEXT NOT NULL,
    notify_conflicts      BOOLEAN NOT NULL DEFAULT TRUE,
    notify_device_offline BOOLEAN NOT NULL DEFAULT TRUE,
    notify_sync_complete  BOOLEAN NOT NULL DEFAULT TRUE,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_push_tokens_account ON push_tokens(account_id);

-- One row per (account, file) conflict already alerted, so a file is announced
-- once. A resolution deletes the row so a later conflict can alert again.
CREATE TABLE IF NOT EXISTS conflict_notices (
    account_id  TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
    file_id     TEXT NOT NULL,
    notified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (account_id, file_id)
);
