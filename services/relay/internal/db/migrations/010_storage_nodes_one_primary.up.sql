-- ============================================================
-- Nodus Relay — Phase 7b hardening: one primary Storage Node per account
-- ============================================================
--
-- The application designates the first Storage Node registered to an account
-- as `is_primary`. That assignment was previously computed in application code
-- with `NOT EXISTS (...)`; two concurrent first-node registrations could each
-- observe "no node yet" and both insert `is_primary = true`, leaving the
-- account with two primaries. This index makes the invariant authoritative at
-- the database layer for both registration paths (/nodes/register and
-- /pairing/codes/redeem).
--
-- Portable SQL (PostgreSQL now, SQLite-compatible where practical): a partial
-- unique index and a correlated-subquery dedupe use only syntax both engines
-- support. No CONCURRENTLY (PostgreSQL-only) and no dual-schema machinery.

-- Keep the oldest primary per account and demote any duplicates. Ties break on
-- node_id so the choice is deterministic. This must run before the unique index
-- or creation would fail on pre-existing duplicate primaries.
UPDATE storage_nodes
SET is_primary = false
WHERE is_primary
  AND node_id <> (
      SELECT candidate.node_id
      FROM storage_nodes AS candidate
      WHERE candidate.account_id = storage_nodes.account_id
        AND candidate.is_primary
      ORDER BY candidate.created_at ASC, candidate.node_id ASC
      LIMIT 1
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_storage_nodes_one_primary
    ON storage_nodes (account_id)
    WHERE is_primary;
