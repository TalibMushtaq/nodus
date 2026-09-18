-- ============================================================
-- Nodus Relay — Backfill file_locations from FILE_SHARD_STORED events
-- ============================================================
--
-- The Relay accepted and journaled FILE_SHARD_STORED events (a Storage Node
-- committing a shard received over Path A/B WebRTC) but never projected them
-- into file_locations. Files therefore listed as "local only" with no
-- downloadable shard locations even though the node held the bytes.
--
-- New events are projected by applySingleEventTx; this one-time backfill makes
-- the shards already stored before the fix downloadable without a re-upload.
-- Only events whose (file_id, version_number) exists under the same account are
-- materialized, matching the projection's FK/ownership guard.
INSERT INTO file_locations
    (file_id, version_number, shard_index, node_id, status, buffer_id, hash, size_bytes, updated_at)
SELECT
    se.payload->>'file_id',
    (se.payload->>'version_number')::int,
    (se.payload->>'shard_index')::int,
    se.origin_id,
    'NODE_STORED',
    NULL,
    se.payload->>'hash',
    NULLIF(se.payload->>'size_bytes', '')::bigint,
    NOW()
FROM sync_events se
JOIN file_versions fv
    ON fv.file_id = se.payload->>'file_id'
   AND fv.version_number = (se.payload->>'version_number')::int
JOIN files f
    ON f.file_id = fv.file_id
   AND f.account_id = se.account_id
WHERE se.event_type = 'FILE_SHARD_STORED'
  AND se.payload->>'file_id' <> ''
  AND se.payload->>'hash' <> ''
ON CONFLICT (file_id, version_number, shard_index, node_id) DO UPDATE SET
    status = 'NODE_STORED',
    buffer_id = NULL,
    hash = EXCLUDED.hash,
    size_bytes = EXCLUDED.size_bytes,
    updated_at = NOW();
