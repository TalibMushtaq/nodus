-- Reverse 020. Recovery envelopes must be removed before the narrower CHECKs
-- can be restored, since no device/node envelope uses that kind.
DELETE FROM key_envelopes WHERE recipient_kind = 'recovery';
DELETE FROM folder_key_envelopes WHERE recipient_kind = 'recovery';
DELETE FROM rebuild_key_envelopes WHERE recipient_kind = 'recovery';
DELETE FROM rebuild_folder_key_envelopes WHERE recipient_kind = 'recovery';

ALTER TABLE key_envelopes DROP CONSTRAINT IF EXISTS key_envelopes_recipient_kind_check;
ALTER TABLE key_envelopes
    ADD CONSTRAINT key_envelopes_recipient_kind_check
    CHECK (recipient_kind IN ('device', 'node'));

ALTER TABLE folder_key_envelopes DROP CONSTRAINT IF EXISTS folder_key_envelopes_recipient_kind_check;
ALTER TABLE folder_key_envelopes
    ADD CONSTRAINT folder_key_envelopes_recipient_kind_check
    CHECK (recipient_kind IN ('device', 'node'));

ALTER TABLE rebuild_key_envelopes DROP CONSTRAINT IF EXISTS rebuild_key_envelopes_recipient_kind_check;
ALTER TABLE rebuild_key_envelopes
    ADD CONSTRAINT rebuild_key_envelopes_recipient_kind_check
    CHECK (recipient_kind IN ('device', 'node'));

ALTER TABLE rebuild_folder_key_envelopes DROP CONSTRAINT IF EXISTS rebuild_folder_key_envelopes_recipient_kind_check;
ALTER TABLE rebuild_folder_key_envelopes
    ADD CONSTRAINT rebuild_folder_key_envelopes_recipient_kind_check
    CHECK (recipient_kind IN ('device', 'node'));

ALTER TABLE accounts DROP COLUMN IF EXISTS recovery_public_key;
