-- Rollback the promoted-snapshot watermark. Re-enables replaying an older
-- snapshot over newer promoted state, so this only belongs in a rollback.
ALTER TABLE storage_nodes
    DROP COLUMN IF EXISTS last_promoted_snapshot_sequence;
