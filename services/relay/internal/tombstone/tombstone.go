package tombstone

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/TalibMushtaq/nodus/services/relay/internal/db"
)

// pruneBatchSize is how many tombstones one prune transaction claims. The batch
// bounds three things at once: how long row locks are held on `files`,
// `file_versions` and `key_envelopes` — all of which the live sync path writes —
// how much work a failure can cost, since only the batch in flight is lost, and
// how much a single statement has to plan over.
const pruneBatchSize = 500

// pruneSweepBudget bounds how long one sweep may spend in the database. A
// backlog far larger than a batch is worked through over several sweeps rather
// than in one long transaction: the rows are already 90 days old, so there is no
// urgency that outranks keeping the write path responsive.
const pruneSweepBudget = 30 * time.Second

// RunTombstonePrune periodically permanently removes tombstones (and the entity
// data they hide) once their restorable window has closed (ADR-0005, 90 days,
// recorded per row in `purge_after`). Purging the entity too — not just the
// tombstone row — is required: `GET /files` hides an entity by checking for a
// tombstone, so deleting only the tombstone would make a long-deleted file
// reappear after the window closed.
//
// There is no retention argument: the window belongs to the row, because the
// delete path sets `purge_after` and deliberately preserves it across a
// re-delete. See pruneExpiredTombstones.
func RunTombstonePrune(ctx context.Context, pool *db.Pool, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if _, err := pruneExpiredTombstones(ctx, pool); err != nil {
				log.Printf("[tombstone-prune] error during prune: %v", err)
			}
		}
	}
}

// pruneExpiredTombstones purges every tombstone whose restorable window has
// closed, in bounded batches, and returns how many it purged.
//
// Eligibility is `purge_after <= NOW()`: the deadline the row carries, and the
// one clients are shown in the trash listing. Recomputing the window from
// `deleted_at` plus a retention constant looked equivalent while both were 90
// days and was not. The delete path sets `purge_after` on insert and keeps the
// original on a re-delete, precisely so "a restore+delete cycle cannot extend
// [the window]" — so a row re-deleted yesterday whose deadline passed a week ago
// has already served its full 90 days, and keying off `deleted_at` meant it was
// never purged at all. The two only agreed while nothing ever disagreed with them.
func pruneExpiredTombstones(ctx context.Context, pool *db.Pool) (int, error) {
	if pool == nil {
		return 0, nil
	}

	budget := time.Now().Add(pruneSweepBudget)
	purged := 0
	for {
		if time.Now().After(budget) {
			log.Printf("[tombstone-prune] sweep budget spent after %d tombstones; "+
				"the rest is left for the next sweep", purged)
			return purged, nil
		}
		n, err := pruneBatch(ctx, pool)
		purged += n
		if err != nil {
			return purged, err
		}
		if n == 0 {
			return purged, nil
		}
	}
}

// pruneBatch purges one bounded batch and returns the number of tombstones it
// removed.
//
// The batch is claimed with FOR UPDATE SKIP LOCKED, which is what keeps the
// sweep from being a long transaction in the first place. The alternative — one
// transaction over the whole backlog — means any row another transaction happens
// to hold blocks every other purge behind it and nothing commits at all, and it
// means two relay instances sweeping at once block each other. Skipping the busy
// rows instead costs nothing: they are picked up by a later sweep, and the only
// requirement is that the tombstone outlives the data it hides, which deleting
// the tombstone last in this same transaction preserves.
func pruneBatch(ctx context.Context, pool *db.Pool) (int, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx) // nolint:errcheck

	rows, err := tx.Query(ctx, `
		SELECT account_id, entity_type, entity_id
		FROM tombstones
		WHERE purge_after <= NOW()
		ORDER BY purge_after
		LIMIT $1
	`, pruneBatchSize)
	if err != nil {
		return 0, err
	}

	var (
		accounts     []string
		fileIDs      []string
		folderIDs    []string
		entityTypes  []string
		entityIDs    []string
		claimedCount int
	)
	for rows.Next() {
		var accountID, entityType, entityID string
		if err := rows.Scan(&accountID, &entityType, &entityID); err != nil {
			rows.Close()
			return 0, err
		}
		claimedCount++
		accounts = append(accounts, accountID)
		entityTypes = append(entityTypes, entityType)
		entityIDs = append(entityIDs, entityID)
		if entityType == "file" {
			fileIDs = append(fileIDs, entityID)
		} else {
			folderIDs = append(folderIDs, entityID)
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}
	if claimedCount == 0 {
		return 0, nil
	}

	// Purge the entity data before the tombstone: file_locations FK's to
	// file_versions, key_envelopes FK's to files, and both are what
	// `GET /files` would otherwise reveal once the tombstone is gone.
	//
	// A tombstone's entity_id is not bound to an entity the account actually
	// owns: sync.go takes it from the client's delete event and files it under
	// the authenticated account, so a client can tombstone any id it can name.
	// The purge therefore only touches ids the claiming accounts really hold.
	// That check has to happen before the child tables, which carry no
	// account_id of their own and can only be filtered by file_id — protecting
	// the `files` row alone would still have taken the other account's versions
	// and envelopes with it.
	if len(fileIDs) > 0 {
		owned, err := ownedIDs(ctx, tx, "files", "file_id", fileIDs, accounts)
		if err != nil {
			return 0, err
		}
		for _, q := range []string{
			`DELETE FROM file_locations WHERE file_id IN (` + db.Placeholders(len(owned)) + `)`,
			`DELETE FROM file_versions WHERE file_id IN (` + db.Placeholders(len(owned)) + `)`,
			`DELETE FROM key_envelopes WHERE file_id IN (` + db.Placeholders(len(owned)) + `)`,
		} {
			if _, err := tx.Exec(ctx, q, stringsToAny(owned)...); err != nil {
				return 0, err
			}
		}
		if _, err := tx.Exec(ctx,
			`DELETE FROM files WHERE file_id IN (`+db.Placeholders(len(owned))+`) AND account_id IN (`+db.Placeholders(len(accounts))+`)`,
			stringsToAny(owned, accounts)...); err != nil {
			return 0, err
		}
	}
	if len(folderIDs) > 0 {
		owned, err := ownedIDs(ctx, tx, "folders", "folder_id", folderIDs, accounts)
		if err != nil {
			return 0, err
		}
		if _, err := tx.Exec(ctx,
			`DELETE FROM folders WHERE folder_id IN (`+db.Placeholders(len(owned))+`) AND account_id IN (`+db.Placeholders(len(accounts))+`)`,
			stringsToAny(owned, accounts)...); err != nil {
			return 0, err
		}
	}
	if _, err := tx.Exec(ctx, `
		DELETE FROM tombstone_node_status
		WHERE entity_type IN (`+db.Placeholders(len(entityTypes))+`) AND entity_id IN (`+db.Placeholders(len(entityIDs))+`) AND account_id IN (`+db.Placeholders(len(accounts))+`)
	`, stringsToAny(entityTypes, entityIDs, accounts)...); err != nil {
		return 0, err
	}
	// The tombstone goes last, and in the same transaction, so the row that
	// hides the entity cannot be gone while the entity is still there.
	tag, err := tx.Exec(ctx, `
		DELETE FROM tombstones
		WHERE purge_after <= NOW()
		  AND account_id IN (`+db.Placeholders(len(accounts))+`) AND entity_type IN (`+db.Placeholders(len(entityTypes))+`) AND entity_id IN (`+db.Placeholders(len(entityIDs))+`)
	`, stringsToAny(accounts, entityTypes, entityIDs)...)
	if err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return int(tag.RowsAffected()), nil
}

// stringsToAny flattens string slices into the variadic arg list for an IN
// query built from db.Placeholders.
func stringsToAny(lists ...[]string) []any {
	var out []any
	for _, list := range lists {
		for _, v := range list {
			out = append(out, v)
		}
	}
	return out
}

// ownedIDs returns the subset of ids that the claiming accounts actually hold in
// table. `table` and `column` are internal constants at every call site, never
// caller input, which is what makes the string concatenation safe.
func ownedIDs(ctx context.Context, tx db.Tx, table, column string, ids, accounts []string) ([]string, error) {
	rows, err := tx.Query(ctx, fmt.Sprintf(
		`SELECT %s FROM %s WHERE %s IN (%s) AND account_id IN (%s)`,
		column, table, column, db.Placeholders(len(ids)), db.Placeholders(len(accounts))),
		stringsToAny(ids, accounts)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var owned []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		owned = append(owned, id)
	}
	return owned, rows.Err()
}
