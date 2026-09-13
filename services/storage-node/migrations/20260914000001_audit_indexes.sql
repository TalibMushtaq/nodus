-- ============================================================
-- Nodus Storage Node — Audit follow-up: missing indexes/constraints
-- ============================================================
--
-- These support hot paths that previously full-scanned:
--   * shards.object_id  — GC's refcount check and reconcile's degraded join
--     run once per pruned/purged object; the PK (file_id, version_number,
--     shard_index) cannot serve them.
--   * storage_objects.status — reconcile, report, and the repair join.
--   * tombstones.deleted_at — GC's expiry scan.
--   * files.parent_folder_id / files.updated_at — folder rollups and the
--     updated-at ordering in report.
--   * sync_outbox(origin_id, origin_sequence) — makes the per-origin sequence
--     unique so a concurrent insert cannot silently corrupt cursor ordering
--     (sync_events already has this constraint).

CREATE INDEX IF NOT EXISTS idx_shards_object
    ON shards (object_id);

CREATE INDEX IF NOT EXISTS idx_storage_objects_status
    ON storage_objects (status);

CREATE INDEX IF NOT EXISTS idx_tombstones_deleted_at
    ON tombstones (deleted_at);

CREATE INDEX IF NOT EXISTS idx_files_parent_folder
    ON files (parent_folder_id);

CREATE INDEX IF NOT EXISTS idx_files_updated_at
    ON files (updated_at);

-- `IF NOT EXISTS` cannot retroactively dedupe; a pre-existing duplicate would
-- abort first boot after upgrade (better than silent corruption). Sequence
-- assignment derives `MAX+1` under SQLite write serialization, so existing
-- databases should be clean.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_outbox_origin_seq
    ON sync_outbox (origin_id, origin_sequence);
