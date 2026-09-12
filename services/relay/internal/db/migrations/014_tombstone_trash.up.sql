-- Tombstone (soft-delete) trash support.
--
-- purge_after bounds how long a soft-deleted entity stays restorable before the
-- retention pruner permanently removes its data (ADR-0005: 90 days).
-- purge_requested_at is set when the user asks to delete permanently; the
-- tombstone (and tombstone_node_status) survives until every owning node acks.

ALTER TABLE tombstones ADD COLUMN IF NOT EXISTS purge_after TIMESTAMPTZ;
ALTER TABLE tombstones ADD COLUMN IF NOT EXISTS purge_requested_at TIMESTAMPTZ;

-- Backfill existing tombstones so the retention window applies retroactively.
UPDATE tombstones
SET purge_after = deleted_at + INTERVAL '90 days'
WHERE purge_after IS NULL;

ALTER TABLE tombstones ALTER COLUMN purge_after SET NOT NULL;

-- Per-node delete/purge progress. `deleted_at` = node applied the tombstone;
-- `purged_at` = node permanently removed the entity's data. Absent rows mean
-- the node has not acked yet (shown as "waiting for node").
CREATE TABLE IF NOT EXISTS tombstone_node_status (
    account_id  TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
    entity_type TEXT NOT NULL,
    entity_id   TEXT NOT NULL,
    node_id     TEXT NOT NULL,
    deleted_at  TIMESTAMPTZ,
    purged_at   TIMESTAMPTZ,
    PRIMARY KEY (account_id, entity_type, entity_id, node_id)
);

CREATE INDEX IF NOT EXISTS idx_tombstone_node_status_entity
    ON tombstone_node_status (account_id, entity_type, entity_id);
