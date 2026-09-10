DROP INDEX IF EXISTS idx_sync_events_origin;

ALTER TABLE sync_events DROP CONSTRAINT IF EXISTS sync_events_account_origin_unique;

ALTER TABLE sync_events
    ADD CONSTRAINT sync_events_origin_id_origin_sequence_key
    UNIQUE (origin_id, origin_sequence);

CREATE INDEX IF NOT EXISTS idx_sync_events_origin ON sync_events(origin_id, origin_sequence);