-- ============================================================
-- Nodus Storage Node — Phase 12: persisted conflicted-copy names (audit M6)
-- ============================================================
--
-- When the node preserves both sides of a version fork it computes a
-- "filename (conflicted copy …)" name (ADR-0003) but previously discarded it.
-- Persisting it here keeps the conflict from being lost and lets local status /
-- the relay catalog surface it; the client inbox UI is a separate feature.

ALTER TABLE file_versions ADD COLUMN conflicted_name TEXT;
