-- #10 preserve-both branch conflicts: persist conflict_status on the node the
-- same way the Relay does (001_initial.up.sql / 002_snapshot_rebuild.up.sql:
-- TEXT NOT NULL DEFAULT 'none' CHECK IN ('none','flagged','resolved')). The
-- node previously parsed conflict_status out of FILE_VERSION_ADDED payloads but
-- had no column to store it, so the flagged state died on arrival.
ALTER TABLE file_versions ADD COLUMN conflict_status TEXT NOT NULL DEFAULT 'none' CHECK (conflict_status IN ('none', 'flagged', 'resolved'));