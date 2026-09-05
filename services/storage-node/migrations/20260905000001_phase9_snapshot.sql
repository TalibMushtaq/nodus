-- ============================================================
-- Nodus Storage Node — Phase 9: Snapshot / Relay Rebuild support
-- ============================================================

-- Monotonic per-node snapshot sequence counter. The node bumps this once per
-- snapshot it produces so the Relay can detect stale/duplicate rebuild
-- attempts and log which snapshot generation is live. Persisted so restarts
-- never reuse a sequence number.
CREATE TABLE IF NOT EXISTS snapshot_counter (
    counter_name TEXT NOT NULL PRIMARY KEY,
    value        INTEGER NOT NULL
);