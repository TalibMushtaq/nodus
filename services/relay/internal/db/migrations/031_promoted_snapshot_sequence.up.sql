-- ============================================================
-- Nodus Relay — Track the newest promoted snapshot per node
-- ============================================================
--
-- `snapshot_sequence` on `snapshot_begin` is the node's own monotonic counter for
-- the snapshot it is about to stream. The Relay received it, logged it, and never
-- compared it to anything, so it could replay an older snapshot and promote it
-- over newer state. Recording the highest sequence already promoted per node
-- makes that comparison possible on the next transfer.
--
-- Per node rather than per account: a node_id is bound to one key and one account
-- for its lifetime (key rotation is a v1 non-goal), so its counter is monotonic
-- within that identity, and a reinstalled node registers a new node_id and
-- correctly starts again from 0.
ALTER TABLE storage_nodes
    ADD COLUMN IF NOT EXISTS last_promoted_snapshot_sequence BIGINT NOT NULL DEFAULT 0;
