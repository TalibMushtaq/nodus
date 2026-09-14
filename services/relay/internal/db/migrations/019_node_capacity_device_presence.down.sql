-- Reverse 019: drop the Overview-only capacity and presence columns.
ALTER TABLE devices DROP COLUMN IF EXISTS last_seen_at;
ALTER TABLE storage_nodes DROP COLUMN IF EXISTS total_bytes;
ALTER TABLE storage_nodes DROP COLUMN IF EXISTS used_bytes;
