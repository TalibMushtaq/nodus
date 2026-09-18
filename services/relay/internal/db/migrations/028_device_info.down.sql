-- Rollback device platform/browser metadata (display-only).
ALTER TABLE devices DROP COLUMN IF EXISTS platform;
ALTER TABLE devices DROP COLUMN IF EXISTS os_version;
ALTER TABLE devices DROP COLUMN IF EXISTS browser;
ALTER TABLE devices DROP COLUMN IF EXISTS app_version;
ALTER TABLE devices DROP COLUMN IF EXISTS user_agent;
