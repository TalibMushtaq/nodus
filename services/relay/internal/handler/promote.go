package handler

import (
	"context"
	"fmt"
	"log"

	"github.com/TalibMushtaq/nodus/services/relay/internal/db"
	"github.com/jackc/pgx/v5"
)

// ── promoteRebuild ─────────────────────────────────────────────────
// Atomically replaces the account's live files / file_versions / tombstones /
// sync_cursors with the verified staged rebuild_* data, inside one transaction.
//
// Design notes (Phase 9, decision #6):
//   - The live tables are shared across accounts, so a global table rename-swap
//     would destroy other accounts' rows. Instead we do a transactional
//     per-account replace: DELETE the account's rows, INSERT from staging, all
//     in a single transaction. The transaction gives the same all-or-nothing
//     guarantee the rename-swap was chosen for.
//   - §22: the account's Relay-buffer entries (file_locations) and key_envelopes
//     must NOT be deleted just because the snapshot doesn't mention them. Their
//     cascade FKs from files/file_versions are dropped before the replace so the
//     DELETE statements cannot cascade into them. On-disk buffer files are never
//     touched by a rebuild.
func promoteRebuild(ctx context.Context, pool *db.Pool, sess *rebuildSession) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin promotion tx: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	acct := sess.accountID

	// 1. Drop the cascading FKs so the account-row DELETEs below cannot cascade
	//    into file_locations (buffer entries, §22) or key_envelopes.
	if err := dropFkViaRel(ctx, tx, "file_locations", "file_versions"); err != nil {
		return fmt.Errorf("drop file_locations->file_versions FK: %w", err)
	}
	if err := dropFkViaRel(ctx, tx, "file_versions", "files"); err != nil {
		return fmt.Errorf("drop file_versions->files FK: %w", err)
	}
	if err := dropFkViaRel(ctx, tx, "key_envelopes", "files"); err != nil {
		return fmt.Errorf("drop key_envelopes->files FK: %w", err)
	}

	// Confirm staging data (defensive; a failed session must not reach here).
	var stagedFiles, stagedVersions, stagedTombstones int64
	if err := tx.QueryRow(ctx,
		`SELECT COUNT(*) FROM rebuild_files WHERE account_id = $1`, acct).Scan(&stagedFiles); err != nil {
		return fmt.Errorf("count staged files: %w", err)
	}
	if err := tx.QueryRow(ctx,
		`SELECT COUNT(*) FROM rebuild_file_versions WHERE account_id = $1`, acct).Scan(&stagedVersions); err != nil {
		return fmt.Errorf("count staged versions: %w", err)
	}
	if err := tx.QueryRow(ctx,
		`SELECT COUNT(*) FROM rebuild_tombstones WHERE account_id = $1`, acct).Scan(&stagedTombstones); err != nil {
		return fmt.Errorf("count staged tombstones: %w", err)
	}

	// 2. Remove the account's rows from the shared live tables. file_locations
	//    and key_envelopes survive because their cascade FKs were dropped above.
	if _, err := tx.Exec(ctx,
		`DELETE FROM file_versions WHERE file_id IN (SELECT file_id FROM files WHERE account_id = $1)`, acct); err != nil {
		return fmt.Errorf("delete live file_versions: %w", err)
	}
	if _, err := tx.Exec(ctx, `DELETE FROM files WHERE account_id = $1`, acct); err != nil {
		return fmt.Errorf("delete live files: %w", err)
	}
	if _, err := tx.Exec(ctx, `DELETE FROM tombstones WHERE account_id = $1`, acct); err != nil {
		return fmt.Errorf("delete live tombstones: %w", err)
	}
	// sync_events are intentionally left untouched: the Relay is the durable
	// origin stream, so erasing events would lose undelivered work. Replay is
	// gated purely by sync_cursors, which are reset to the snapshot checkpoint
	// below — anything at or below that point is considered applied and
	// skipped, anything above it is still delivered.
	if _, err := tx.Exec(ctx, `DELETE FROM sync_cursors WHERE account_id = $1`, acct); err != nil {
		return fmt.Errorf("delete live sync_cursors: %w", err)
	}

	// 3. Insert the staged snapshot data into the live tables.
	if _, err := tx.Exec(ctx, `
		INSERT INTO files (file_id, account_id, parent_folder_id, encrypted_name, created_at, updated_at)
		SELECT file_id, account_id, parent_folder_id, encrypted_name, created_at, updated_at
		FROM rebuild_files
		WHERE account_id = $1
	`, acct); err != nil {
		return fmt.Errorf("insert live files: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO file_versions (file_id, version_number, parent_version_id, conflict_status, version_hash, shard_count, created_at)
		SELECT file_id, version_number, parent_version_id, conflict_status, version_hash, shard_count, created_at
		FROM rebuild_file_versions
		WHERE account_id = $1
	`, acct); err != nil {
		return fmt.Errorf("insert live file_versions: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO tombstones (account_id, entity_type, entity_id, deleted_at)
		SELECT account_id, entity_type, entity_id, deleted_at
		FROM rebuild_tombstones
		WHERE account_id = $1
	`, acct); err != nil {
		return fmt.Errorf("insert live tombstones: %w", err)
	}

	// 4. Repopulate per-origin sync_cursors from the snapshot's cursor map so
	//    Phase 8 incremental sync resumes from the snapshot's checkpoint.
	for _, cur := range sess.cursors {
		if _, err := tx.Exec(ctx, `
			INSERT INTO sync_cursors (account_id, peer_id, last_sequence, updated_at)
			VALUES ($1, $2, $3, NOW())
			ON CONFLICT (account_id, peer_id) DO UPDATE SET
				last_sequence = EXCLUDED.last_sequence,
				updated_at = NOW()
		`, acct, cur.OriginID, cur.Sequence); err != nil {
			return fmt.Errorf("insert sync_cursor for %s: %w", cur.OriginID, err)
		}
	}

	// 5. §22 — buffer entries whose file version no longer exists locally (the
	//    file was deleted on the node) cannot satisfy the FK we are about to
	//    restore. Their on-disk buffer FILES are left untouched (never deleted
	//    by a rebuild); only the DB row is removed, and Path C / TTL lifecycle
	//    remains the sole owner of buffer cleanup. Key envelopes for files that
	//    no longer exist are removed likewise.
	if _, err := tx.Exec(ctx, `
		DELETE FROM file_locations fl
		WHERE NOT EXISTS (
			SELECT 1 FROM file_versions v
			WHERE v.file_id = fl.file_id AND v.version_number = fl.version_number
		)
	`); err != nil {
		return fmt.Errorf("prune orphaned file_locations: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		DELETE FROM key_envelopes ke
		WHERE NOT EXISTS (SELECT 1 FROM files f WHERE f.file_id = ke.file_id)
	`); err != nil {
		return fmt.Errorf("prune orphaned key_envelopes: %w", err)
	}

	// 6. Restore the cascade FKs with explicit names so future DELETE/UPDATE
	//    behaviour is preserved.
	if err := addFkViaRel(ctx, tx, "file_locations", "file_versions",
		"(file_id, version_number) REFERENCES file_versions (file_id, version_number) ON DELETE CASCADE",
		"fk_file_locations_file_version"); err != nil {
		return fmt.Errorf("restore file_locations FK: %w", err)
	}
	if err := addFkViaRel(ctx, tx, "file_versions", "files",
		"(file_id) REFERENCES files (file_id) ON DELETE CASCADE",
		"fk_file_versions_file"); err != nil {
		return fmt.Errorf("restore file_versions FK: %w", err)
	}
	if err := addFkViaRel(ctx, tx, "key_envelopes", "files",
		"(file_id) REFERENCES files (file_id) ON DELETE CASCADE",
		"fk_key_envelopes_file"); err != nil {
		return fmt.Errorf("restore key_envelopes FK: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit promotion tx: %w", err)
	}

	// 7. Clear this account's staged rows now that they've been promoted.
	cleanupStagedData(ctx, pool, acct)

	log.Printf("[snapshot] promoted rebuild for account=%s: files=%d versions=%d tombstones=%d cursors=%d",
		acct, stagedFiles, stagedVersions, stagedTombstones, len(sess.cursors))
	return nil
}

// cleanupStagedData removes an account's rows from all rebuild_* staging
// tables. Used after a successful promotion and on abort, so partial transfers
// never leak into a later session.
func cleanupStagedData(ctx context.Context, pool *db.Pool, accountID string) {
	if _, err := pool.Exec(ctx, `DELETE FROM rebuild_files WHERE account_id = $1`, accountID); err != nil {
		log.Printf("[snapshot] warning: clearing rebuild_files for %s: %v", accountID, err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM rebuild_file_versions WHERE account_id = $1`, accountID); err != nil {
		log.Printf("[snapshot] warning: clearing rebuild_file_versions for %s: %v", accountID, err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM rebuild_tombstones WHERE account_id = $1`, accountID); err != nil {
		log.Printf("[snapshot] warning: clearing rebuild_tombstones for %s: %v", accountID, err)
	}
}

// dropFkViaRel drops any FK constraint on `child` that references `parent`,
// regardless of its auto-generated name (the initial migration left them
// unnamed, so Postgres picked the default <child>_<col>_fkey names).
func dropFkViaRel(ctx context.Context, tx pgx.Tx, child, parent string) error {
	var conname string
	err := tx.QueryRow(ctx, `
		SELECT conname FROM pg_constraint
		WHERE conrelid = to_regclass($1)::oid
		  AND contype = 'f'
		  AND confrelid = to_regclass($2)::oid
		LIMIT 1
	`, child, parent).Scan(&conname)
	if err != nil {
		// No such constraint — nothing to drop.
		return nil
	}
	_, err = tx.Exec(ctx, fmt.Sprintf(`ALTER TABLE %s DROP CONSTRAINT "%s"`, child, conname))
	return err
}

// addFkViaRel re-adds an explicitly-named FK constraint.
func addFkViaRel(ctx context.Context, tx pgx.Tx, child, parent, definition, conName string) error {
	sql := fmt.Sprintf(`ALTER TABLE %s ADD CONSTRAINT %s FOREIGN KEY %s`, child, conName, definition)
	if _, err := tx.Exec(ctx, sql); err != nil {
		return err
	}
	return nil
}