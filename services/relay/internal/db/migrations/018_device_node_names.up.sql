-- ============================================================
-- Nodus Relay — user-assigned display names for nodes and devices
-- ============================================================
--
-- The Relay catalogue only stored cryptographic ids, so the Devices page could
-- show nothing human-readable. Operators can now label each storage node and
-- client device; the name is account-scoped metadata and is never part of a
-- snapshot rebuild (these tables are not rebuilt), nor shared with peers beyond
-- the owning account's GET /nodes and GET /devices responses.

ALTER TABLE devices ADD COLUMN IF NOT EXISTS display_name TEXT;
ALTER TABLE storage_nodes ADD COLUMN IF NOT EXISTS display_name TEXT;
