-- ============================================================
-- Nodus Relay — Rollback backfill of FILE_SHARD_STORED locations
-- ============================================================
--
-- Deliberately a no-op: the backfilled rows are indistinguishable from rows
-- written by the live projection, and the shards they describe are genuinely
-- stored on the node. Deleting them would re-strand every affected download.
SELECT 1;
