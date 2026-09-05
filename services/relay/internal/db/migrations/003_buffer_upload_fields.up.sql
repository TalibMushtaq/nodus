-- ============================================================
-- Nodus Relay — Phase 10: Buffer upload fields on file_locations
-- ============================================================

-- Required by the upload handler and pending_notify: the node needs
-- the encrypted shard hash and size to verify after fetch, and the
-- Relay needs source_device to populate from_device in pending_notify.
ALTER TABLE file_locations ADD COLUMN IF NOT EXISTS hash TEXT;
ALTER TABLE file_locations ADD COLUMN IF NOT EXISTS size_bytes BIGINT;
ALTER TABLE file_locations ADD COLUMN IF NOT EXISTS source_device TEXT;
