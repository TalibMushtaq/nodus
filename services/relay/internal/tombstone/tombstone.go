package tombstone

import (
	"context"
	"log"
	"time"

	"github.com/TalibMushtaq/nodus/services/relay/internal/db"
)

// RunTombstonePrune periodically deletes tombstones older than the retention
// window (90 days, ADR-0005). This prevents long-offline device resurrection
// while bounding tombstone table growth. Deadlines are based on deleted_at.
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

	query := `
		DELETE FROM tombstones
		WHERE deleted_at < $1
	`
	tag, err := pool.Exec(ctx, query, cutoff)
	if err != nil {
		return err
	}
	if n := tag.RowsAffected(); n > 0 {
		log.Printf("[tombstone-prune] removed %d expired tombstones (window %s)", n, retention)
	}
	return nil
}
