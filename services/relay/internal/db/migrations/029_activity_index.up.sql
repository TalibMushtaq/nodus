-- ============================================================
-- Nodus Relay — Index the ACTIVITY_LOGGED journal for the activity feed
-- ============================================================
--
-- The activity feed is read straight from sync_events (event_type =
-- 'ACTIVITY_LOGGED') rather than a second projection table, so the read path is
-- `WHERE account_id = ? AND event_type = ? ORDER BY timestamp DESC`. This
-- composite index serves that query without scanning the account's whole event
-- journal, which grows with every file/folder/key event.
CREATE INDEX IF NOT EXISTS idx_sync_events_account_activity
    ON sync_events (account_id, event_type, timestamp DESC);
