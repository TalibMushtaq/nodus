-- ============================================================
-- Nodus Relay — Device platform/browser metadata
-- ============================================================
--
-- Captured automatically from the client at login/register so the Devices list
-- can say "iPhone · iOS 17 · Nodus 1.4" or "Linux · Chrome 126" instead of only
-- a short device id. All nullable: older clients send nothing, and the value is
-- display-only (never trusted for auth), so it is stored as free text and
-- COALESCEd on re-registration.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS platform     TEXT;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS os_version   TEXT;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS browser      TEXT;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS app_version  TEXT;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS user_agent   TEXT;
