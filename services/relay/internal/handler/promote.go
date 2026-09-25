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
	// Folder-key envelopes cascade from folders; drop that FK too so the
	// account-wide folder DELETE below cannot erase them before we replace them
	// from staging.
	if err := dropFkViaRel(ctx, tx, "folder_key_envelopes", "folders"); err != nil {
		return fmt.Errorf("drop folder_key_envelopes->folders FK: %w", err)
	}

	// Confirm staging data (defensive; a failed session must not reach here).
	var stagedFiles, stagedFolders, stagedEnvelopes, stagedFolderEnvelopes, stagedVersions, stagedTombstones, stagedActivities int64
	if err := tx.QueryRow(ctx,
		`SELECT COUNT(*) FROM rebuild_files WHERE account_id = $1`, acct).Scan(&stagedFiles); err != nil {
		return fmt.Errorf("count staged files: %w", err)
	}
	if err := tx.QueryRow(ctx,
		`SELECT COUNT(*) FROM rebuild_key_envelopes WHERE account_id = $1`, acct).Scan(&stagedEnvelopes); err != nil {
		return fmt.Errorf("count staged key envelopes: %w", err)
	}
	if err := tx.QueryRow(ctx,
		`SELECT COUNT(*) FROM rebuild_folder_key_envelopes WHERE account_id = $1`, acct).Scan(&stagedFolderEnvelopes); err != nil {
		return fmt.Errorf("count staged folder key envelopes: %w", err)
	}
	if err := tx.QueryRow(ctx,
		`SELECT COUNT(*) FROM rebuild_folders WHERE account_id = $1`, acct).Scan(&stagedFolders); err != nil {
		return fmt.Errorf("count staged folders: %w", err)
	}
	if err := tx.QueryRow(ctx,
		`SELECT COUNT(*) FROM rebuild_file_versions WHERE account_id = $1`, acct).Scan(&stagedVersions); err != nil {
		return fmt.Errorf("count staged versions: %w", err)
	}
	if err := tx.QueryRow(ctx,
		`SELECT COUNT(*) FROM rebuild_tombstones WHERE account_id = $1`, acct).Scan(&stagedTombstones); err != nil {
		return fmt.Errorf("count staged tombstones: %w", err)
	}
	if err := tx.QueryRow(ctx,
		`SELECT COUNT(*) FROM rebuild_activities WHERE account_id = $1`, acct).Scan(&stagedActivities); err != nil {
		return fmt.Errorf("count staged activities: %w", err)
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
	// Folder-key envelopes must be cleared explicitly: their folders FK was
	// dropped above, so the folder DELETE below will not cascade to them.
	if _, err := tx.Exec(ctx, `
		DELETE FROM folder_key_envelopes
		WHERE folder_id IN (SELECT folder_id FROM folders WHERE account_id = $1)
	`, acct); err != nil {
		return fmt.Errorf("delete live folder_key_envelopes: %w", err)
	}
	if _, err := tx.Exec(ctx, `DELETE FROM folders WHERE account_id = $1`, acct); err != nil {
		return fmt.Errorf("delete live folders: %w", err)
	}
	if _, err := tx.Exec(ctx, `DELETE FROM tombstones WHERE account_id = $1`, acct); err != nil {
		return fmt.Errorf("delete live tombstones: %w", err)
	}
	// The snapshot is authoritative for the feed; anything created on the Relay
	// after the snapshot was taken is re-delivered via the event journal.
	if _, err := tx.Exec(ctx, `DELETE FROM activities WHERE account_id = $1`, acct); err != nil {
		return fmt.Errorf("delete live activities: %w", err)
	}
	// sync_events are intentionally left untouched: the Relay is the durable
	// origin stream, so erasing events would lose undelivered work. Replay is
	// gated purely by sync_cursors, which are reset to the snapshot checkpoint
	// below — anything at or below that point is considered applied and
	// skipped, anything above it is still delivered.
	if _, err := tx.Exec(ctx, `DELETE FROM sync_cursors WHERE account_id = $1`, acct); err != nil {
		return fmt.Errorf("delete live sync_cursors: %w", err)
	}

	// 3. Insert the staged snapshot data into the live tables. Folders go first
	//    so a later reader never sees a file whose parent folder is absent (there
	//    is no FK, but insert order keeps the intermediate state coherent).
	if _, err := tx.Exec(ctx, `
		INSERT INTO folders (folder_id, account_id, parent_folder_id, encrypted_name, created_at, updated_at)
		SELECT folder_id, account_id, parent_folder_id, encrypted_name, created_at, created_at
		FROM rebuild_folders
		WHERE account_id = $1
	`, acct); err != nil {
		return fmt.Errorf("insert live folders: %w", err)
	}
	// Folder keys from the snapshot, mirroring the file-envelope replace below.
	if _, err := tx.Exec(ctx, `
		INSERT INTO folder_key_envelopes (folder_id, recipient_id, recipient_kind, encrypted_key, created_at)
		SELECT folder_id, recipient_id, recipient_kind, encrypted_key, created_at
		FROM rebuild_folder_key_envelopes
		WHERE account_id = $1
	`, acct); err != nil {
		return fmt.Errorf("insert live folder_key_envelopes: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO files (file_id, account_id, parent_folder_id, encrypted_name, created_at, updated_at)
		SELECT file_id, account_id, parent_folder_id, encrypted_name, created_at, updated_at
		FROM rebuild_files
		WHERE account_id = $1
	`, acct); err != nil {
		return fmt.Errorf("insert live files: %w", err)
	}
	// Replace the account's FEK envelopes from the snapshot. Once envelopes are
	// snapshotted the node is authoritative, so stale live rows are removed
	// rather than preserved (§22 preserve behavior no longer applies). Orphans
	// for files no longer present are pruned in step 5.
	if _, err := tx.Exec(ctx, `
		DELETE FROM key_envelopes
		WHERE file_id IN (SELECT file_id FROM files WHERE account_id = $1)
	`, acct); err != nil {
		return fmt.Errorf("delete live key_envelopes: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO key_envelopes (file_id, recipient_id, recipient_kind, encrypted_key, created_at)
		SELECT file_id, recipient_id, recipient_kind, encrypted_key, created_at
		FROM rebuild_key_envelopes
		WHERE account_id = $1
	`, acct); err != nil {
		return fmt.Errorf("insert live key_envelopes: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO file_versions (file_id, version_number, parent_version_id, conflict_status, version_hash, shard_count, conflicted_name, created_at)
		SELECT file_id, version_number, parent_version_id, conflict_status, version_hash, shard_count, conflicted_name, created_at
		FROM rebuild_file_versions
		WHERE account_id = $1
	`, acct); err != nil {
		return fmt.Errorf("insert live file_versions: %w", err)
	}
	// Signed per-shard hashes (audit #22). The live rows for these files were
	// removed by the file_versions delete above via ON DELETE CASCADE.
	if _, err := tx.Exec(ctx, `
		INSERT INTO file_version_shard_hashes (file_id, version_number, shard_index, shard_hash)
		SELECT file_id, version_number, shard_index, shard_hash
		FROM rebuild_file_version_shard_hashes
		WHERE account_id = $1
	`, acct); err != nil {
		return fmt.Errorf("insert live file_version_shard_hashes: %w", err)
	}
	// `rebuild_tombstones` predates the trash window (migration 014), so it has
	// no purge_after. Derive it from deleted_at exactly as the live tombstone
	// path does, or the NOT NULL constraint rejects the promote.
	if _, err := tx.Exec(ctx, `
		INSERT INTO tombstones (account_id, entity_type, entity_id, deleted_at, purge_after)
		SELECT account_id, entity_type, entity_id, deleted_at, deleted_at + INTERVAL '90 days'
		FROM rebuild_tombstones
		WHERE account_id = $1
	`, acct); err != nil {
		return fmt.Errorf("insert live tombstones: %w", err)
	}
	// Activity feed restored from the snapshot (projected live from
	// ACTIVITY_LOGGED events; carried here so a rebuild keeps the history).
	if _, err := tx.Exec(ctx, `
		INSERT INTO activities
			(account_id, activity_id, origin_id, kind, outcome, file_id, path, detail, created_at)
		SELECT account_id, activity_id, origin_id, kind, outcome, file_id, path, detail, created_at
		FROM rebuild_activities
		WHERE account_id = $1
	`, acct); err != nil {
		return fmt.Errorf("insert live activities: %w", err)
	}

	// 4. Repopulate per-origin sync_cursors from the snapshot's cursor map so
	//    Phase 8 incremental sync resumes from the snapshot's checkpoint.
	//    The map is untrusted input — see validateSnapshotCursors — so it is
	//    checked before any of it is written, not as it is inserted.
	cursors, err := validateSnapshotCursors(ctx, tx, acct, sess.cursors)
	if err != nil {
		return err
	}
	for _, cur := range cursors {
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
	if _, err := tx.Exec(ctx, `
		DELETE FROM folder_key_envelopes fe
		WHERE NOT EXISTS (SELECT 1 FROM folders f WHERE f.folder_id = fe.folder_id)
	`); err != nil {
		return fmt.Errorf("prune orphaned folder_key_envelopes: %w", err)
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
	if err := addFkViaRel(ctx, tx, "folder_key_envelopes", "folders",
		"(folder_id) REFERENCES folders (folder_id) ON DELETE CASCADE",
		"fk_folder_key_envelopes_folder"); err != nil {
		return fmt.Errorf("restore folder_key_envelopes FK: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit promotion tx: %w", err)
	}

	// 7. Clear this account's staged rows now that they've been promoted.
	cleanupStagedData(ctx, pool, acct)

	log.Printf("[snapshot] promoted rebuild for account=%s: files=%d folders=%d envelopes=%d folder_envelopes=%d versions=%d tombstones=%d activities=%d cursors=%d",
		acct, stagedFiles, stagedFolders, stagedEnvelopes, stagedFolderEnvelopes, stagedVersions, stagedTombstones, stagedActivities, len(cursors))
	return nil
}

// validateSnapshotCursors screens the cursor map a snapshot asks the Relay to
// adopt, which promotion then writes over the account's live sync_cursors.
//
// The map is not covered by the node's signature. HandleSnapshotBegin verifies
// an Ed25519 signature over the *content hash* only (snapshot.go), and
// `cursors` is a sibling field of that same BEGIN payload, so its origin ids and
// sequences are attacker-controlled by anything holding the primary node's
// socket. Promotion used to insert them verbatim with DO UPDATE SET, so a
// compromised or malicious primary could set any origin's cursor to any value.
//
// A cursor is a claim about what has already been applied, so a false claim is
// not self-correcting:
//
//   - Too high wedges the origin permanently. The Phase 14 sequence check
//     rejects the peer's next real event as `sequence_regression`, and no API
//     lowers a cursor, so that peer can never sync again without a factory
//     reset.
//   - Too high also silently discards undelivered work: catch-up sync serves
//     events after the cursor, so every event between the real high-water mark
//     and the forged one is never sent to any peer.
//   - Negative rewinds the origin, letting a peer re-apply already-applied
//     events.
//
// The bound enforced here is therefore: a cursor may not claim a sequence above
// the highest the Relay has actually accepted from that origin. That is safe for
// an honest node, whose local cursor is only advanced when it applies an event
// the Relay sent it (services/storage-node/src/sync/engine.rs, apply_event), so
// the Relay necessarily logged that event first.
//
// Origins the Relay has no events for are deliberately NOT bounded. After a
// factory reset the whole schema, including sync_events, is gone while the node
// still holds its cursors; rejecting those would break the rebuild the snapshot
// exists to perform. The node is then the only authority for its own state.
//
// A rejected map aborts the whole promotion rather than clamping: the cursors
// decide which events replay, so a snapshot whose cursor map is not trustworthy
// cannot be partially believed.
func validateSnapshotCursors(ctx context.Context, q dbQuerier, accountID string, cursors []SnapshotCursor) ([]SnapshotCursor, error) {
	seen := make(map[string]struct{}, len(cursors))
	out := make([]SnapshotCursor, 0, len(cursors))
	for _, cur := range cursors {
		switch {
		case cur.OriginID == "":
			return nil, fmt.Errorf("snapshot cursor has an empty origin_id")
		case cur.Sequence < 0:
			return nil, fmt.Errorf("snapshot cursor for %s has negative sequence %d", cur.OriginID, cur.Sequence)
		}
		if _, dup := seen[cur.OriginID]; dup {
			return nil, fmt.Errorf("snapshot cursor map lists origin %s twice", cur.OriginID)
		}
		seen[cur.OriginID] = struct{}{}

		var logMax *int64
		if err := q.QueryRow(ctx, `
			SELECT MAX(origin_sequence) FROM sync_events
			WHERE account_id = $1 AND origin_id = $2
		`, accountID, cur.OriginID).Scan(&logMax); err != nil {
			return nil, fmt.Errorf("read sync_events high-water mark for %s: %w", cur.OriginID, err)
		}
		// NULL means the Relay holds no events from this origin at all, which is
		// the post-reset rebuild case: nothing to check the claim against.
		if logMax != nil && cur.Sequence > *logMax {
			return nil, fmt.Errorf(
				"snapshot cursor for %s claims sequence %d but the Relay's highest accepted event from that origin is %d",
				cur.OriginID, cur.Sequence, *logMax)
		}
		out = append(out, cur)
	}
	return out, nil
}

// cleanupStagedData removes an account's rows from all rebuild_* staging
// tables. Used after a successful promotion and on abort, so partial transfers
// never leak into a later session.
func cleanupStagedData(ctx context.Context, pool *db.Pool, accountID string) {
	if _, err := pool.Exec(ctx, `DELETE FROM rebuild_files WHERE account_id = $1`, accountID); err != nil {
		log.Printf("[snapshot] warning: clearing rebuild_files for %s: %v", accountID, err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM rebuild_folders WHERE account_id = $1`, accountID); err != nil {
		log.Printf("[snapshot] warning: clearing rebuild_folders for %s: %v", accountID, err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM rebuild_key_envelopes WHERE account_id = $1`, accountID); err != nil {
		log.Printf("[snapshot] warning: clearing rebuild_key_envelopes for %s: %v", accountID, err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM rebuild_folder_key_envelopes WHERE account_id = $1`, accountID); err != nil {
		log.Printf("[snapshot] warning: clearing rebuild_folder_key_envelopes for %s: %v", accountID, err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM rebuild_file_versions WHERE account_id = $1`, accountID); err != nil {
		log.Printf("[snapshot] warning: clearing rebuild_file_versions for %s: %v", accountID, err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM rebuild_tombstones WHERE account_id = $1`, accountID); err != nil {
		log.Printf("[snapshot] warning: clearing rebuild_tombstones for %s: %v", accountID, err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM rebuild_activities WHERE account_id = $1`, accountID); err != nil {
		log.Printf("[snapshot] warning: clearing rebuild_activities for %s: %v", accountID, err)
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
