package buffer

import (
	"context"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"time"

	"github.com/TalibMushtaq/nodus/services/relay/internal/db"
	"github.com/TalibMushtaq/nodus/services/relay/internal/rdb"
	"github.com/google/uuid"
)

// Buffer manages temporary encrypted shard storage on the local filesystem.
type Buffer struct {
	dir string
}

// New creates a new Buffer manager and ensures the root buffer directory exists.
func New(dir string) (*Buffer, error) {
	if err := os.MkdirAll(dir, 0755); err != nil {
		return nil, fmt.Errorf("creating buffer directory %s: %w", dir, err)
	}
	return &Buffer{dir: dir}, nil
}

// Dir returns the root buffer directory path.
func (b *Buffer) Dir() string {
	return b.dir
}

// Store writes data to the buffer atomically using write-temp-then-rename.
func (b *Buffer) Store(bufferID string, data []byte) error {
	destPath := filepath.Join(b.dir, bufferID)
	tempPath := filepath.Join(b.dir, fmt.Sprintf(".tmp-%s-%s", bufferID, uuid.NewString()))

	f, err := os.OpenFile(tempPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0644)
	if err != nil {
		return fmt.Errorf("creating temp buffer file: %w", err)
	}

	if _, err := f.Write(data); err != nil {
		_ = f.Close()
		_ = os.Remove(tempPath)
		return fmt.Errorf("writing buffer data: %w", err)
	}

	if err := f.Sync(); err != nil {
		_ = f.Close()
		_ = os.Remove(tempPath)
		return fmt.Errorf("syncing buffer data: %w", err)
	}

	if err := f.Close(); err != nil {
		_ = os.Remove(tempPath)
		return fmt.Errorf("closing temp buffer file: %w", err)
	}

	if err := os.Rename(tempPath, destPath); err != nil {
		_ = os.Remove(tempPath)
		return fmt.Errorf("committing buffer file: %w", err)
	}

	return nil
}

// Fetch reads the buffered data by bufferID.
func (b *Buffer) Fetch(bufferID string) ([]byte, error) {
	destPath := filepath.Join(b.dir, bufferID)
	return os.ReadFile(destPath)
}

// Delete removes the buffered file from disk.
func (b *Buffer) Delete(bufferID string) error {
	destPath := filepath.Join(b.dir, bufferID)
	if err := os.Remove(destPath); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

// Exists checks if the buffer file exists on disk.
func (b *Buffer) Exists(bufferID string) bool {
	destPath := filepath.Join(b.dir, bufferID)
	_, err := os.Stat(destPath)
	return err == nil
}

// RunTTLSweep periodically checks for expired buffered shards, deletes their files,
// and marks their database records as 'RELAY_CLEANUP'.
func RunTTLSweep(ctx context.Context, pool *db.Pool, rClient *rdb.Client, buf *Buffer, ttl time.Duration, checkInterval time.Duration) {
	ticker := time.NewTicker(checkInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := sweepExpiredBuffers(ctx, pool, rClient, buf, ttl); err != nil {
				log.Printf("[buffer-sweep] error during sweep: %v", err)
			}
		}
	}
}

func sweepExpiredBuffers(ctx context.Context, pool *db.Pool, rClient *rdb.Client, buf *Buffer, ttl time.Duration) error {
	if pool == nil {
		return nil
	}

	if err := sweepExpiredRelayBuffered(ctx, pool, rClient, buf, ttl); err != nil {
		return err
	}
	if err := sweepOrphanedUploading(ctx, pool); err != nil {
		return err
	}
	return sweepStuckInTransit(ctx, pool, rClient, inTransitGrace)
}

// orphanUploadGrace is how long an UPLOADING row may sit before the sweep
// treats it as abandoned. UPLOADING is a transient pre-commit reservation, so
// it needs a much shorter leash than RELAY_BUFFERED (which legitimately waits
// for an offline node).
const orphanUploadGrace = time.Hour

// sweepOrphanedUploading clears UPLOADING rows whose client vanished mid-upload
// (crashed before body + hash completed). These hold no buffer file, so they are
// just marked RELAY_CLEANUP to keep the terminal-state invariant.
func sweepOrphanedUploading(ctx context.Context, pool *db.Pool) error {
	cutoff := time.Now().UTC().Add(-orphanUploadGrace)
	_, err := pool.Exec(ctx, `
		UPDATE file_locations
		SET status = 'RELAY_CLEANUP', updated_at = NOW()
		WHERE status = 'UPLOADING' AND updated_at < $1
	`, cutoff)
	if err != nil {
		return fmt.Errorf("sweeping orphaned UPLOADING rows: %w", err)
	}
	return nil
}

// inTransitGrace is how long a shard may sit in NODE_RECEIVING /
// NODE_VERIFIED before the sweep treats the carrying node as crashed
// mid-transfer. Both states still reference their buffer file (NODE_STORED is
// what clears buffer_id), so reverting to RELAY_BUFFERED loses nothing and lets
// the node re-fetch on its next reconnect.
const inTransitGrace = 30 * time.Minute

// sweepStuckInTransit reverts in-flight shards whose node vanished before
// acking. Without this, a node crash between fetch and verified/verified and
// stored would strand the shard in a non-terminal state that neither reconnect
// delivery (queries RELAY_BUFFERED) nor the TTL sweep would ever touch.
func sweepStuckInTransit(ctx context.Context, pool *db.Pool, rClient *rdb.Client, grace time.Duration) error {
	cutoff := time.Now().UTC().Add(-grace)

	rows, err := pool.Query(ctx, `
		SELECT file_id, version_number, shard_index, node_id, buffer_id
		FROM file_locations
		WHERE status IN ('NODE_RECEIVING', 'NODE_VERIFIED')
		  AND buffer_id IS NOT NULL
		  AND updated_at < $1
	`, cutoff)
	if err != nil {
		return fmt.Errorf("querying stuck in-transit shards: %w", err)
	}
	defer rows.Close()

	type inTransit struct {
		fileID        string
		versionNumber int
		shardIndex    int
		nodeID        string
		bufferID      string
	}

	var stuck []inTransit
	for rows.Next() {
		var s inTransit
		if err := rows.Scan(&s.fileID, &s.versionNumber, &s.shardIndex, &s.nodeID, &s.bufferID); err != nil {
			log.Printf("[buffer-sweep] error scanning stuck row: %v", err)
			continue
		}
		stuck = append(stuck, s)
	}

	for _, s := range stuck {
		// Re-arm as deliverable so checkAndDeliverPendingShards re-notifies the
		// node on its next register.
		ct, err := pool.Exec(ctx, `
			UPDATE file_locations
			SET status = 'RELAY_BUFFERED', updated_at = NOW()
			WHERE file_id = $1 AND version_number = $2 AND shard_index = $3 AND node_id = $4
			  AND status IN ('NODE_RECEIVING', 'NODE_VERIFIED')
		`, s.fileID, s.versionNumber, s.shardIndex, s.nodeID)
		if err != nil {
			log.Printf("[buffer-sweep] error reverting stuck shard for %s: %v", s.bufferID, err)
			continue
		}
		if ct.RowsAffected() == 0 {
			continue
		}
		if rClient != nil {
			_ = rClient.AddPendingBuffer(ctx, s.nodeID, s.bufferID)
		}
		log.Printf("[buffer-sweep] reverted stuck shard %s (file: %s shard: %d node: %s) to RELAY_BUFFERED",
			s.bufferID, s.fileID, s.shardIndex, s.nodeID)
	}

	return nil
}

func sweepExpiredRelayBuffered(ctx context.Context, pool *db.Pool, rClient *rdb.Client, buf *Buffer, ttl time.Duration) error {
	cutoff := time.Now().UTC().Add(-ttl)

	query := `
		SELECT file_id, version_number, shard_index, node_id, buffer_id
		FROM file_locations
		WHERE status = 'RELAY_BUFFERED' AND buffer_id IS NOT NULL AND updated_at < $1
	`

	rows, err := pool.Query(ctx, query, cutoff)
	if err != nil {
		return fmt.Errorf("querying expired buffers: %w", err)
	}
	defer rows.Close()

	type expiredShard struct {
		fileID        string
		versionNumber int
		shardIndex    int
		nodeID        string
		bufferID      string
	}

	var expired []expiredShard
	for rows.Next() {
		var s expiredShard
		if err := rows.Scan(&s.fileID, &s.versionNumber, &s.shardIndex, &s.nodeID, &s.bufferID); err != nil {
			log.Printf("[buffer-sweep] error scanning expired row: %v", err)
			continue
		}
		expired = append(expired, s)
	}

	for _, s := range expired {
		// Delete on-disk file
		if err := buf.Delete(s.bufferID); err != nil {
			log.Printf("[buffer-sweep] warning: failed to delete buffer file %s: %v", s.bufferID, err)
		}

		// Update database status to RELAY_CLEANUP
		updateQuery := `
			UPDATE file_locations
			SET status = 'RELAY_CLEANUP', buffer_id = NULL, updated_at = NOW()
			WHERE file_id = $1 AND version_number = $2 AND shard_index = $3 AND node_id = $4
		`
		if _, err := pool.Exec(ctx, updateQuery, s.fileID, s.versionNumber, s.shardIndex, s.nodeID); err != nil {
			log.Printf("[buffer-sweep] error updating status for %s: %v", s.bufferID, err)
		}

		// Remove from Redis pending list if redis is available
		if rClient != nil {
			_ = rClient.RemovePendingBuffer(ctx, s.nodeID, s.bufferID)
		}

		log.Printf("[buffer-sweep] cleaned up expired buffer %s (file: %s shard: %d node: %s)",
			s.bufferID, s.fileID, s.shardIndex, s.nodeID)
	}

	return nil
}
