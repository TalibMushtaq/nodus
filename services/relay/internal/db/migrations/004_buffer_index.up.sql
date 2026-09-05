-- ============================================================
-- Nodus Relay — Phase 10: Index for pending shard delivery query
-- ============================================================

-- Supports the pending-delivery query in checkAndDeliverPendingShards:
--   SELECT … WHERE node_id = ? AND status = 'RELAY_BUFFERED'
-- Also supports the upload handler's status-update queries.
CREATE INDEX IF NOT EXISTS idx_file_locations_node_status
    ON file_locations(node_id, status);
