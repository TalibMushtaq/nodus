-- Per-device X25519 encryption public key (ADR-0008).
--
-- Senders seal a file/folder key to this key directly instead of deriving
-- X25519 from the device's Ed25519 identity. Nullable: devices registered
-- before this migration have no published key and keep the legacy derivation
-- until they next authenticate with one.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS encryption_public_key TEXT;
