package tombstone

import (
	"context"
	"log"
	"time"

	"github.com/TalibMushtaq/nodus/services/relay/internal/db"
)

// RunTombstonePrune periodically permanently removes tombstones (and the
// entity data they hide) once the retention window has elapsed (90 days,
// ADR-0005). Purging the entity too — not just the tombstone row — is required:
// `GET /files` hides an entity by checking for a tombstone, so deleting only the
// tombstone would make a long-deleted file reappear after 90 days.
func RunTombstonePrune(ctx context.Context, pool *db.Pool, retention time.Duration, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := pruneExpiredTombstones(ctx, pool, retention); err != nil {
				log.Printf("[tombstone-prune] error during prune: %v", err)
			}
		}
	}
}

func pruneExpiredTombstones(ctx context.Context, pool *db.Pool, retention time.Duration) error {
	if pool == nil {
		return nil
	}

	cutoff := time.Now().UTC().Add(-retention)

	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) // nolint:errcheck

	// Purge file data first (file_locations FK's to file_versions), then folder
	// rows, then the tombstone/status bookkeeping.
	filePurges := []string{
		`DELETE FROM file_locations WHERE file_id IN (
			SELECT entity_id FROM tombstones WHERE entity_type = 'file' AND deleted_at < $1)`,
		`DELETE FROM file_versions WHERE file_id IN (
			SELECT entity_id FROM tombstones WHERE entity_type = 'file' AND deleted_at < $1)`,
		`DELETE FROM key_envelopes WHERE file_id IN (
			SELECT entity_id FROM tombstones WHERE entity_type = 'file' AND deleted_at < $1)`,
		`DELETE FROM files WHERE file_id IN (
			SELECT entity_id FROM tombstones WHERE entity_type = 'file' AND deleted_at < $1)`,
	}
	for _, q := range filePurges {
		if _, err := tx.Exec(ctx, q, cutoff); err != nil {
			return err
		}
	}

	if _, err := tx.Exec(ctx, `
		DELETE FROM folders WHERE folder_id IN (
			SELECT entity_id FROM tombstones WHERE entity_type = 'folder' AND deleted_at < $1)
	`, cutoff); err != nil {
		return err
	}

	if _, err := tx.Exec(ctx, `
		DELETE FROM tombstone_node_status
		WHERE (entity_type, entity_id) IN (
			SELECT entity_type, entity_id FROM tombstones WHERE deleted_at < $1)
	`, cutoff); err != nil {
		return err
	}

	tag, err := tx.Exec(ctx, `DELETE FROM tombstones WHERE deleted_at < $1`, cutoff)
	if err != nil {
		return err
	}

	if err := tx.Commit(ctx); err != nil {
		return err
	}
	if n := tag.RowsAffected(); n > 0 {
		log.Printf("[tombstone-prune] purged %d expired tombstones and their data (window %s)", n, retention)
	}
	return nil
}
