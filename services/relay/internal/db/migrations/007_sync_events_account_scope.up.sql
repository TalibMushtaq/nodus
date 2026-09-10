-- Phase 14a audit (V3): sync_events uniqueness must be per-account.
--
-- The original UNIQUE(origin_id, origin_sequence) was global, so account A
-- could pre-insert a "poison" row keyed on account B's (origin_id,origin_sequence)
-- and B's real event would silently die on ON CONFLICT ... DO NOTHING. Origin
-- sequences are per-origin logical clocks; resolution only matters within one
-- account, so the key becomes (account_id, origin_id, origin_sequence).

DROP INDEX IF EXISTS idx_sync_events_origin;

ALTER TABLE sync_events DROP CONSTRAINT IF EXISTS sync_events_origin_id_origin_sequence_key;

ALTER TABLE sync_events
    ADD CONSTRAINT sync_events_account_origin_unique
    UNIQUE (account_id, origin_id, origin_sequence);

-- Keep the lookup index for sync_hello's per-origin cursor queries.
CREATE INDEX IF NOT EXISTS idx_sync_events_origin ON sync_events(origin_id, origin_sequence);