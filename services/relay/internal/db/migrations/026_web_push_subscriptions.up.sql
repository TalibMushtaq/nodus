-- Browser (Web Push) subscriptions, alongside the Expo tokens in push_tokens.
--
-- A subscription is keyed by its endpoint URL; p256dh/auth are the client's
-- public key and auth secret used to encrypt the payload. Per-category opt-outs
-- mirror push_tokens so the Relay honours them the same way.
CREATE TABLE IF NOT EXISTS web_push_subscriptions (
    endpoint              TEXT PRIMARY KEY,
    account_id            TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
    p256dh                TEXT NOT NULL,
    auth                  TEXT NOT NULL,
    notify_conflicts      BOOLEAN NOT NULL DEFAULT TRUE,
    notify_device_offline BOOLEAN NOT NULL DEFAULT TRUE,
    notify_sync_complete  BOOLEAN NOT NULL DEFAULT TRUE,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_web_push_account ON web_push_subscriptions(account_id);
