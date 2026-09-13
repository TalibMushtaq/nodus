-- ============================================================
-- Nodus Storage Node — folder key envelopes
-- ============================================================
--
-- Folder names are encrypted with a per-folder key that must reach the account's
-- other devices. The node cannot decrypt these envelopes; it persists and
-- snapshots them so a Relay rebuild stays lossless, mirroring `key_envelopes`
-- (20260912000002). Deliberately no FK to `folders`: an envelope can arrive
-- before the folder row, and a failed projection after journaling would be
-- treated as AlreadyApplied on retry (never projected) — same rationale as the
-- file envelope table.

CREATE TABLE IF NOT EXISTS folder_key_envelopes (
    folder_id        TEXT NOT NULL,
    recipient_id     TEXT NOT NULL,
    recipient_kind   TEXT NOT NULL CHECK (recipient_kind IN ('device', 'node')),
    encrypted_key    TEXT NOT NULL,
    created_at       TEXT NOT NULL,
    PRIMARY KEY (folder_id, recipient_id)
);
