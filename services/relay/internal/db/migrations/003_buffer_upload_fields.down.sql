-- ============================================================
-- Nodus Relay — Phase 10: Rollback buffer upload fields
-- ============================================================

ALTER TABLE file_locations DROP COLUMN IF EXISTS source_device;
ALTER TABLE file_locations DROP COLUMN IF EXISTS size_bytes;
ALTER TABLE file_locations DROP COLUMN IF EXISTS hash;
