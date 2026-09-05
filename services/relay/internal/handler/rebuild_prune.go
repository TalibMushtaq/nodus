package handler

import (
	"context"
	"log"
	"time"

	"github.com/TalibMushtaq/nodus/services/relay/internal/db"
)

// RunRebuildRequestPrune periodically deletes terminal (delivered/failed)
// rebuild_requests older than the retention window. This keeps the audit table
// bounded; pending requests are never pruned because they may still be
// delivered to a reconnecting primary node.
func RunRebuildRequestPrune(ctx context.Context, pool *db.Pool, retention time.Duration, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := pruneExpiredRebuildRequests(ctx, pool, retention); err != nil {
				log.Printf("[rebuildprune] error during prune: %v", err)
			}
		}
	}
}

func pruneExpiredRebuildRequests(ctx context.Context, pool *db.Pool, retention time.Duration) error {
	if pool == nil {
		return nil
	}

	cutoff := time.Now().UTC().Add(-retention)

	query := `
		DELETE FROM rebuild_requests
		WHERE status IN ('delivered', 'failed')
		  AND created_at < $1
	`
	tag, err := pool.Exec(ctx, query, cutoff)
	if err != nil {
		return err
	}
	if n := tag.RowsAffected(); n > 0 {
		log.Printf("[rebuildprune] removed %d terminal rebuild_requests older than %s", n, retention)
	}
	return nil
}
