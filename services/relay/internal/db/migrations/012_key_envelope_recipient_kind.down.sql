ALTER TABLE key_envelopes DROP CONSTRAINT IF EXISTS key_envelopes_recipient_kind_check;
ALTER TABLE key_envelopes DROP COLUMN IF EXISTS recipient_kind;
