-- ============================================================
-- Nodus Storage Node — Phase 13: Transfer Manager path cache
-- ============================================================
--
-- Adds columns to track which transfer path last succeeded for each
-- trusted peer, so the Transfer Manager can attempt that path first
-- on the next transfer to the same node (see docs/architecture/
-- transfer-manager-spec.md, §"Path Cache Persistence").

ALTER TABLE trusted_nodes ADD COLUMN last_successful_path TEXT;
ALTER TABLE trusted_nodes ADD COLUMN last_success_at TEXT;
