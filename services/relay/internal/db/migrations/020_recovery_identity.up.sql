-- ============================================================
-- Nodus Relay — Account recovery identity (ADR-0002)
-- ============================================================
--
-- The account gains a recovery Ed25519 public key derived from a BIP39 phrase
-- the user keeps offline. Every file/folder key is also sealed to it, so a
-- recovery device holding the phrase can re-open the account's content. The
-- Relay stores only the public key — the phrase never leaves the client.
--
-- Envelopes addressed to the recovery key use recipient_kind = 'recovery'; the
-- existing CHECKs only allow 'device'/'node', so they are recreated to add it.

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS recovery_public_key TEXT;

-- key_envelopes: the CHECK was added by name in 012.
ALTER TABLE key_envelopes DROP CONSTRAINT IF EXISTS key_envelopes_recipient_kind_check;
ALTER TABLE key_envelopes
    ADD CONSTRAINT key_envelopes_recipient_kind_check
    CHECK (recipient_kind IN ('device', 'node', 'recovery'));

-- folder_key_envelopes / rebuild_* carried inline CHECKs, which Postgres names
-- <table>_recipient_kind_check.
ALTER TABLE folder_key_envelopes DROP CONSTRAINT IF EXISTS folder_key_envelopes_recipient_kind_check;
ALTER TABLE folder_key_envelopes
    ADD CONSTRAINT folder_key_envelopes_recipient_kind_check
    CHECK (recipient_kind IN ('device', 'node', 'recovery'));

ALTER TABLE rebuild_key_envelopes DROP CONSTRAINT IF EXISTS rebuild_key_envelopes_recipient_kind_check;
ALTER TABLE rebuild_key_envelopes
    ADD CONSTRAINT rebuild_key_envelopes_recipient_kind_check
    CHECK (recipient_kind IN ('device', 'node', 'recovery'));

ALTER TABLE rebuild_folder_key_envelopes DROP CONSTRAINT IF EXISTS rebuild_folder_key_envelopes_recipient_kind_check;
ALTER TABLE rebuild_folder_key_envelopes
    ADD CONSTRAINT rebuild_folder_key_envelopes_recipient_kind_check
    CHECK (recipient_kind IN ('device', 'node', 'recovery'));
