-- ============================================================
-- Nodus Relay — drop the one-primary-per-account invariant
-- ============================================================

DROP INDEX IF EXISTS idx_storage_nodes_one_primary;
