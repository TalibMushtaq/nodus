-- ADR-0002: allow recovery-recipient key envelopes on the node.
--
-- The account's recovery identity receives an envelope for every file/folder
-- key so an offline recovery via this node can hand those envelopes to a new
-- device. The node still cannot open them; it only stores and snapshots them.
--
-- SQLite cannot alter a CHECK constraint, so both tables are rebuilt with the
-- widened constraint and their rows copied across. Neither table has dependent
-- foreign keys, so no foreign_keys toggle is needed.

CREATE TABLE key_envelopes_new (
    file_id        TEXT NOT NULL,
    recipient_id   TEXT NOT NULL,
    recipient_kind TEXT NOT NULL CHECK (recipient_kind IN ('device', 'node', 'recovery')),
    encrypted_key  TEXT NOT NULL,
    created_at     TEXT NOT NULL,
    PRIMARY KEY (file_id, recipient_id)
);
INSERT INTO key_envelopes_new (file_id, recipient_id, recipient_kind, encrypted_key, created_at)
    SELECT file_id, recipient_id, recipient_kind, encrypted_key, created_at FROM key_envelopes;
DROP TABLE key_envelopes;
ALTER TABLE key_envelopes_new RENAME TO key_envelopes;
CREATE INDEX idx_key_envelopes_recipient ON key_envelopes (recipient_id);

CREATE TABLE folder_key_envelopes_new (
    folder_id        TEXT NOT NULL,
    recipient_id     TEXT NOT NULL,
    recipient_kind   TEXT NOT NULL CHECK (recipient_kind IN ('device', 'node', 'recovery')),
    encrypted_key    TEXT NOT NULL,
    created_at       TEXT NOT NULL,
    PRIMARY KEY (folder_id, recipient_id)
);
INSERT INTO folder_key_envelopes_new (folder_id, recipient_id, recipient_kind, encrypted_key, created_at)
    SELECT folder_id, recipient_id, recipient_kind, encrypted_key, created_at FROM folder_key_envelopes;
DROP TABLE folder_key_envelopes;
ALTER TABLE folder_key_envelopes_new RENAME TO folder_key_envelopes;
-- Offline recovery hands envelopes to a reclaiming device keyed by recipient_id
-- (the recovery public key), so both tables get a lookup index as part of the
-- rebuild.
CREATE INDEX idx_folder_key_envelopes_recipient ON folder_key_envelopes (recipient_id);
