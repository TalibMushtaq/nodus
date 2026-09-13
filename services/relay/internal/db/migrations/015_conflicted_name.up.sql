-- ADR-0003 conflicted-copy name on the relay's file_versions projection.
--
-- The node computes the sibling name when it preserves a version fork and now
-- carries it in node→relay rebuild snapshots. Persisting it here keeps the
-- display name across a relay rebuild instead of dropping it; `conflict_status`
-- (already stored) remains the field the inbox filters on.

ALTER TABLE file_versions ADD COLUMN conflicted_name TEXT;
ALTER TABLE rebuild_file_versions ADD COLUMN conflicted_name TEXT;
