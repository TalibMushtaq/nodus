-- ============================================================
-- Nodus Relay — folder key envelopes
-- ============================================================
--
-- Folder names are encrypted with a per-folder key, exactly like file names are
-- encrypted with the file's FEK. Without a way to distribute that key, only the
-- creating device could ever render a folder's name. This mirrors the file
-- `key_envelopes` table (001) and its snapshot staging table (013), keyed by
-- folder_id instead of file_id.
--
-- The FK to folders cascades, so permanently purging a folder removes its
-- envelopes automatically; `rebuild_folder_key_envelopes` is account-scoped like
-- the other rebuild_* tables so a snapshot rebuild stays isolated per account.

CREATE TABLE IF NOT EXISTS folder_key_envelopes (
    folder_id        TEXT        NOT NULL REFERENCES folders(folder_id) ON DELETE CASCADE,
    recipient_id     TEXT        NOT NULL,
    recipient_kind   TEXT        NOT NULL CHECK (recipient_kind IN ('device', 'node')),
    encrypted_key    TEXT        NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (folder_id, recipient_id)
);

-- Device revocation deletes envelopes by recipient_id; without this the revoke
-- path would sequentially scan every folder envelope.
CREATE INDEX IF NOT EXISTS idx_folder_key_envelopes_recipient
    ON folder_key_envelopes (recipient_id);

CREATE TABLE IF NOT EXISTS rebuild_folder_key_envelopes (
    account_id       TEXT        NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
    folder_id        TEXT        NOT NULL,
    recipient_id     TEXT        NOT NULL,
    recipient_kind   TEXT        NOT NULL CHECK (recipient_kind IN ('device', 'node')),
    encrypted_key    TEXT        NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (account_id, folder_id, recipient_id)
);
