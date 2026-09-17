-- ADR-0003 addendum: record which version the user chose to keep when resolving
-- a conflicted file. NULL means "no explicit choice", and clients fall back to
-- the newest version (the pre-existing behaviour).
--
-- Deliberately additive: no version rows or shards are removed, so choosing a
-- side is reversible and cannot lose the other branch of the conflict.
ALTER TABLE files ADD COLUMN IF NOT EXISTS preferred_version INTEGER;
