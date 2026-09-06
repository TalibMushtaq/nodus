-- ============================================================
-- Phase 11 fix: add account_id to local pairing_sessions table
-- ============================================================
-- The Relay now includes account_id in the WS push payload so
-- the local fast path can return it in /nodus/pair responses
-- without a Relay round-trip.
--
-- Existing rows (tokens pushed before this migration) get an
-- empty string; they will expire within 15 minutes anyway.

ALTER TABLE pairing_sessions ADD COLUMN account_id TEXT NOT NULL DEFAULT '';
