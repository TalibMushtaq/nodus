-- ============================================================
-- Nodus Relay — Phase 14 F2: key-envelope recipient kind
-- ============================================================
--
-- KEY_ENVELOPE_ADDED has always carried recipient_kind ("device" | "node"),
-- but the projection dropped it. The download path (F2b) needs it, and
-- retrofitting after more envelopes exist would require a data backfill.
--
-- Every envelope written before this migration came from the current uploader,
-- which can only reach devices (node recipients have no code path yet), so the
-- default backfills safely.
ALTER TABLE key_envelopes
    ADD COLUMN IF NOT EXISTS recipient_kind TEXT NOT NULL DEFAULT 'device';

ALTER TABLE key_envelopes
    ADD CONSTRAINT key_envelopes_recipient_kind_check
    CHECK (recipient_kind IN ('device', 'node'));
