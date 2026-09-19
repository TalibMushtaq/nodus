-- ============================================================
-- Nodus Relay — first-class activity feed + rebuild staging
-- ============================================================
--
-- Activities were initially read straight from sync_events, but a full Relay
-- rebuild from a Node snapshot does not replay the event journal (snapshots
-- carry domain projections). A dedicated `activities` table can be projected
-- from ACTIVITY_LOGGED events live and restored from a snapshot, so the feed
-- survives a rebuild.
CREATE TABLE IF NOT EXISTS activities (
    account_id  TEXT        NOT NULL,
    activity_id TEXT        NOT NULL,
    origin_id   TEXT        NOT NULL,
    kind        TEXT        NOT NULL,
    outcome     TEXT        NOT NULL,
    file_id     TEXT,
    path        TEXT,
    detail      TEXT,
    created_at  TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (account_id, activity_id)
);

CREATE INDEX IF NOT EXISTS idx_activities_account_created
    ON activities (account_id, created_at DESC);

-- Staging for a snapshot-driven rebuild, mirroring the other rebuild_* tables.
CREATE TABLE IF NOT EXISTS rebuild_activities (
    account_id  TEXT        NOT NULL,
    activity_id TEXT        NOT NULL,
    origin_id   TEXT        NOT NULL,
    kind        TEXT        NOT NULL,
    outcome     TEXT        NOT NULL,
    file_id     TEXT,
    path        TEXT,
    detail      TEXT,
    created_at  TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (account_id, activity_id)
);

-- The 029 index supported reading activities from sync_events; the feed is now
-- served from `activities`, so drop the now-unused journal index.
DROP INDEX IF EXISTS idx_sync_events_account_activity;
