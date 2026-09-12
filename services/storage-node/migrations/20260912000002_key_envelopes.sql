-- Phase 14 F2c: key envelopes on the node.
--
-- The node stores the opaque FEK envelopes it receives from devices purely so a
-- full Relay rebuild can restore them. It never possesses the FEK and cannot
-- open an envelope. Shape mirrors the Relay's key_envelopes table.
CREATE TABLE IF NOT EXISTS key_envelopes (
    file_id        TEXT NOT NULL,
    recipient_id   TEXT NOT NULL,
    recipient_kind TEXT NOT NULL CHECK (recipient_kind IN ('device', 'node')),
    encrypted_key  TEXT NOT NULL,
    created_at     TEXT NOT NULL,
    PRIMARY KEY (file_id, recipient_id)
    -- Deliberately no FK to files: envelopes can be applied before their file
    -- row arrives, and a failed projection after the event is journaled would
    -- be treated as AlreadyApplied on retry (never projected).
);
