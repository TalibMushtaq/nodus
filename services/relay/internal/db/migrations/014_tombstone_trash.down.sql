DROP INDEX IF EXISTS idx_tombstone_node_status_entity;
DROP TABLE IF EXISTS tombstone_node_status;
ALTER TABLE tombstones DROP COLUMN IF EXISTS purge_requested_at;
ALTER TABLE tombstones DROP COLUMN IF EXISTS purge_after;
