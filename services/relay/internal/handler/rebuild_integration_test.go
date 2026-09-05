package handler

import (
	"context"
	"os"
	"testing"

	"github.com/TalibMushtaq/nodus/services/relay/internal/config"
	"github.com/TalibMushtaq/nodus/services/relay/internal/db"
	"github.com/stretchr/testify/require" //nolint:depguard
)

// mustExec runs a statement and fails the test on error.
func mustExec(t *testing.T, pool *db.Pool, sql string, args ...any) {
	t.Helper()
	_, err := pool.Exec(context.Background(), sql, args...)
	require.NoError(t, err)
}

// This integration test exercises the Phase 9 promotion against a real Postgres.
// It requires TEST_DATABASE_URL to be set (run the migrations first). It covers
// the §22 guarantee: a rebuild must never cascade-delete Relay-buffer entries,
// plus FK re-establishment after the per-account swap.
func TestPromoteRebuildIntegration(t *testing.T) {
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set; skipping integration test")
	}

	ctx := context.Background()
	if err := db.RunMigrations(url); err != nil {
		t.Fatalf("run migrations: %v", err)
	}
	pool, err := db.Open(ctx, &config.Config{DatabaseURL: url})
	if err != nil {
		t.Fatalf("open pool: %v", err)
	}
	t.Cleanup(pool.Close)

	accountID := "acct-integration"
	nodeID := "node-primary"
	// A stable public key so the node rows satisfy NOT NULL.
	const pubKey = "d1b2c3a4"

	mustExec(t, pool, `DELETE FROM rebuild_files WHERE account_id=$1`, accountID)
	mustExec(t, pool, `DELETE FROM rebuild_file_versions WHERE account_id=$1`, accountID)
	mustExec(t, pool, `DELETE FROM rebuild_tombstones WHERE account_id=$1`, accountID)
	mustExec(t, pool, `DELETE FROM file_versions WHERE file_id IN (SELECT file_id FROM files WHERE account_id=$1)`, accountID)
	mustExec(t, pool, `DELETE FROM files WHERE account_id=$1`, accountID)
	mustExec(t, pool, `DELETE FROM tombstones WHERE account_id=$1`, accountID)
	mustExec(t, pool, `DELETE FROM sync_events WHERE account_id=$1`, accountID)
	mustExec(t, pool, `DELETE FROM sync_cursors WHERE account_id=$1`, accountID)
	mustExec(t, pool, `DELETE FROM key_envelopes WHERE file_id IN (SELECT file_id FROM files WHERE account_id=$1)`, accountID)
	mustExec(t, pool, `DELETE FROM storage_nodes WHERE account_id=$1`, accountID)
	mustExec(t, pool, `DELETE FROM accounts WHERE account_id=$1`, accountID)

	mustExec(t, pool, `
		INSERT INTO accounts (account_id, email, password_hash) VALUES ($1, $2, $3)
	`, accountID, "integ@test.dev", "x")
	mustExec(t, pool, `
		INSERT INTO storage_nodes (node_id, account_id, public_key, is_primary) VALUES ($1, $2, $3, $4)
	`, nodeID, accountID, pubKey, true)

	t.Run("promotes staged data and protects buffer", func(t *testing.T) {
		const fileA = "file-a"
		const fileB = "file-b"

		// Seed pre-existing live data that the snapshot does NOT contain
		// (file A gone on the node), including a pending Relay-buffer entry.
		mustExec(t, pool, `
			INSERT INTO files (file_id, account_id, encrypted_name, created_at, updated_at)
			VALUES ($1, $2, 'old-live-file', NOW(), NOW())
		`, fileA, accountID)
		mustExec(t, pool, `
			INSERT INTO file_versions (file_id, version_number, version_hash, shard_count)
			VALUES ($1, 1, 'old-hash', 2)
		`, fileA)
		mustExec(t, pool, `
			INSERT INTO file_locations (file_id, version_number, shard_index, node_id, status, buffer_id)
			VALUES ($1, 1, 0, $2, 'RELAY_BUFFERED', NULL),
			       ($1, 1, 1, $2, 'RELAY_BUFFERED', NULL)
		`, fileA, nodeID)

		// Seed sync state and cursors that the snapshot cursor map must replace.
		mustExec(t, pool, `
			INSERT INTO sync_cursors (account_id, peer_id, last_sequence)
			VALUES ($1, 'stale-peer', 999)
		`, accountID)
		mustExec(t, pool, `
			INSERT INTO sync_events (event_id, account_id, origin_id, origin_sequence, event_type, payload, timestamp)
			VALUES ('evt-live', $1, 'origin-live', 1, 'file_version', '{}'::jsonb, NOW())
		`, accountID)
		// A key envelope referencing a file that will not survive the rebuild.
		mustExec(t, pool, `
			INSERT INTO files (file_id, account_id, encrypted_name)
			VALUES ('file-without-version', $1, 'old-file')
		`, accountID)
		mustExec(t, pool, `
			INSERT INTO key_envelopes (file_id, recipient_id, encrypted_key)
			VALUES ('file-without-version', 'recipient-1', 'enc-key')
		`)

		// Stage the rebuilt snapshot: only file B exists now (file A deleted).
		mustExec(t, pool, `
			INSERT INTO rebuild_files (file_id, account_id, encrypted_name)
			VALUES ($1, $2, 'file-b')
		`, fileB, accountID)
		mustExec(t, pool, `
			INSERT INTO rebuild_file_versions (file_id, account_id, version_number, version_hash, shard_count)
			VALUES ($1, $2, 1, 'b-hash', 2)
		`, fileB, accountID)
		mustExec(t, pool, `
			INSERT INTO rebuild_tombstones (account_id, entity_type, entity_id, deleted_at)
			VALUES ($1, 'file', 'file-a', NOW())
		`, accountID)

		sess := &rebuildSession{
			snapshotID: "snap-integration",
			nodeID:     nodeID,
			accountID:  accountID,
			cursors: []SnapshotCursor{
				{OriginID: "origin-b", Sequence: 42},
			},
		}
		require.NoError(t, promoteRebuild(ctx, pool, sess))

		// 1. Live files now reflect the snapshot (file A gone, file B present).
		var liveFileB, liveFileA int
		require.NoError(t, pool.QueryRow(ctx,
			`SELECT COUNT(*) FROM files WHERE account_id=$1 AND file_id=$2`, accountID, fileB).Scan(&liveFileB))
		require.NoError(t, pool.QueryRow(ctx,
			`SELECT COUNT(*) FROM files WHERE account_id=$1 AND file_id=$2`, accountID, fileA).Scan(&liveFileA))
		require.Equal(t, 1, liveFileB)
		require.Equal(t, 0, liveFileA)

		// 2. §22: an existing buffer row is pruned ONLY when its version is gone.
		var orphanRows int
		require.NoError(t, pool.QueryRow(ctx,
			`SELECT COUNT(*) FROM file_locations WHERE file_id=$1`, fileA).Scan(&orphanRows))
		require.Equal(t, 0, orphanRows, "orphaned buffer row for deleted file A should be pruned")

		// 3. Tombstone staged data promoted.
		var tombCount int
		require.NoError(t, pool.QueryRow(ctx,
			`SELECT COUNT(*) FROM tombstones WHERE account_id=$1 AND entity_id='file-a'`, accountID).Scan(&tombCount))
		require.Equal(t, 1, tombCount)

		// 4. Cursors replaced by the snapshot cursor map; stale-peer gone.
		var staleCursor int
		require.NoError(t, pool.QueryRow(ctx,
			`SELECT COUNT(*) FROM sync_cursors WHERE account_id=$1 AND peer_id='stale-peer'`, accountID).Scan(&staleCursor))
		require.Equal(t, 0, staleCursor)
		var newCursor int64
		require.NoError(t, pool.QueryRow(ctx,
			`SELECT last_sequence FROM sync_cursors WHERE account_id=$1 AND peer_id='origin-b'`, accountID).Scan(&newCursor))
		require.Equal(t, int64(42), newCursor)

		// 5. Undelivered sync events survive the rebuild (the Relay is the durable
		//    origin stream); replay is gated by the refreshed cursors instead.
		var syncEvents int
		require.NoError(t, pool.QueryRow(ctx,
			`SELECT COUNT(*) FROM sync_events WHERE account_id=$1`, accountID).Scan(&syncEvents))
		require.Equal(t, 1, syncEvents)

		// 6. Key envelope for a file that no longer exists is pruned.
		var keGone int
		require.NoError(t, pool.QueryRow(ctx,
			`SELECT COUNT(*) FROM key_envelopes WHERE file_id='file-without-version'`).Scan(&keGone))
		require.Equal(t, 0, keGone)

		// 7. FKs are restored with explicit names and enforce the deletions
		//    that used to cascade.
		var fkCount int
		require.NoError(t, pool.QueryRow(ctx, `
			SELECT COUNT(*) FROM pg_constraint
			WHERE contype='f'
			  AND (conname LIKE 'fk_file_locations_file_version%'
			    OR conname LIKE 'fk_file_versions_file%'
			    OR conname LIKE 'fk_key_envelopes_file%')
		`).Scan(&fkCount))
		require.Equal(t, 3, fkCount, "all three cascade FKs must be present after promotion")

		// FK actually enforced: inserting a versionless file_location must fail.
		_, fkErr := pool.Exec(ctx, `
			INSERT INTO file_locations (file_id, version_number, shard_index, node_id)
			VALUES ('no-such-file', 1, 0, $1)
		`, nodeID)
		require.Error(t, fkErr, "FK must reject orphaned buffer rows")

		// And deleting a live version cascades to buffer rows again.
		mustExec(t, pool, `
			INSERT INTO files (file_id, account_id) VALUES ($1, $2)
		`, "cascade-check", accountID)
		mustExec(t, pool, `
			INSERT INTO file_versions (file_id, version_number, version_hash, shard_count)
			VALUES ('cascade-check', 1, 'h', 1)
		`)
		mustExec(t, pool, `
			INSERT INTO file_locations (file_id, version_number, shard_index, node_id)
			VALUES ('cascade-check', 1, 0, $1)
		`, nodeID)
		mustExec(t, pool, `DELETE FROM file_versions WHERE file_id='cascade-check'`)
		var cascadedOut int
		require.NoError(t, pool.QueryRow(ctx,
			`SELECT COUNT(*) FROM file_locations WHERE file_id='cascade-check'`).Scan(&cascadedOut))
		require.Equal(t, 0, cascadedOut, "ON DELETE CASCADE must be re-established")
	})
}