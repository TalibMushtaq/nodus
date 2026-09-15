-- The account this Storage Node is bound to (ADR-0002 offline recovery).
--
-- Pairing already learned the account_id but only used it for the immediate
-- response; the offline recovery endpoints need it later to tell a recovering
-- client which account it is bound to and to return an account_id for the
-- client's local stores. Single-row by construction (the CHECK pins id = 1).
CREATE TABLE IF NOT EXISTS node_account (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    account_id TEXT NOT NULL,
    paired_at  TEXT NOT NULL
);
