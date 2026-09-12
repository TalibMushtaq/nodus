-- Phase 14 F1: folder catalog.
--
-- files.parent_folder_id already existed, but there was no folders table, so a
-- folder event had nowhere to project. The folder tree must be durable on the
-- node so a Relay rebuild snapshot can reconstruct it losslessly.
CREATE TABLE IF NOT EXISTS folders (
    folder_id        TEXT NOT NULL PRIMARY KEY,
    parent_folder_id TEXT,
    -- Encrypted, opaque to the node; the client holds the key.
    encrypted_name   TEXT,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL
);
