package handler

import (
	"context"
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/TalibMushtaq/nodus/services/relay/internal/config"
	"github.com/TalibMushtaq/nodus/services/relay/internal/db"
	"github.com/TalibMushtaq/nodus/services/relay/internal/hub"
	"github.com/stretchr/testify/require"
)

// newTestingClient builds a minimal authenticated hub.Client for the snapshot
// handlers. Only the fields those handlers read are populated.
func newTestingClient(accountID, nodeID string) *hub.Client {
	return &hub.Client{
		AccountID:       accountID,
		NodeID:          nodeID,
		ConnID:          "conn-" + nodeID,
		IsAuthenticated: true,
		Send:            make(chan []byte, 8),
	}
}

func mkEnv(msgType string, payload any) ProtocolEnvelope {
	b, _ := json.Marshal(payload)
	return ProtocolEnvelope{Type: msgType, Payload: b}
}

// e2eHarness bundles the live resources a snapshot-ingestion test needs.
type e2eHarness struct {
	ctx       context.Context
	pool      *db.Pool
	client    *hub.Client
	accountID string
	sign      func([]byte) string
}

// setupE2E opens the test DB (or skips), registers a primary node with a real
// Ed25519 key, and returns a harness whose sign() can forge valid signatures.
func setupE2E(t *testing.T) *e2eHarness {
	t.Helper()
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

	accountID := "acct-e2e"
	nodeID := "node-e2e"

	pubKey, privKey, err := ed25519.GenerateKey(nil)
	require.NoError(t, err)
	pubKeyHex := hex.EncodeToString(pubKey)
	sign := func(message []byte) string {
		return hex.EncodeToString(ed25519.Sign(privKey, message))
	}

	mustExec(t, pool, `DELETE FROM rebuild_files WHERE account_id=$1`, accountID)
	mustExec(t, pool, `DELETE FROM rebuild_file_versions WHERE account_id=$1`, accountID)
	mustExec(t, pool, `DELETE FROM rebuild_tombstones WHERE account_id=$1`, accountID)
	mustExec(t, pool, `DELETE FROM file_versions WHERE file_id IN (SELECT file_id FROM files WHERE account_id=$1)`, accountID)
	mustExec(t, pool, `DELETE FROM files WHERE account_id=$1`, accountID)
	mustExec(t, pool, `DELETE FROM tombstones WHERE account_id=$1`, accountID)
	mustExec(t, pool, `DELETE FROM sync_cursors WHERE account_id=$1`, accountID)
	mustExec(t, pool, `DELETE FROM storage_nodes WHERE account_id=$1`, accountID)
	mustExec(t, pool, `DELETE FROM accounts WHERE account_id=$1`, accountID)

	mustExec(t, pool, `INSERT INTO accounts (account_id, email, password_hash) VALUES ($1, $2, $3)`,
		accountID, "e2e@test.dev", "x")
	mustExec(t, pool, `INSERT INTO storage_nodes (node_id, account_id, public_key, is_primary) VALUES ($1, $2, $3, $4)`,
		nodeID, accountID, pubKeyHex, true)

	return &e2eHarness{
		ctx:       ctx,
		pool:      pool,
		client:    newTestingClient(accountID, nodeID),
		accountID: accountID,
		sign:      sign,
	}
}

// runSnapshotStreams streams a two-chunk snapshot (one file_version chunk, one
// tombstone chunk) through BEGIN+CHUNK handlers and returns the active session.
// The BEGIN carries `beginHash` (signed); pass the pre-computed content hash for
// a successful transfer, or a bogus value to test hash-mismatch rejection.
func (h *e2eHarness) runSnapshotStreams(t *testing.T, snapshotID, beginHash string) *rebuildSession {
	t.Helper()

	chunk1Records := []byte(`[{"file_id":"chunk-file","version_number":1,"version_hash":"chunk-hash","shard_count":2}]`)
	chunk2Records := []byte(`[{"entity_type":"folder","entity_id":"tomb-folder","deleted_at":"2026-09-01T00:00:00Z"}]`)
	if beginHash == "" {
		beginHash, _ = hashSnapshotRecords([][]byte{chunk1Records, chunk2Records})
	}

	begin := SnapshotBeginPayload{
		SnapshotID:        snapshotID,
		NodeID:            h.client.NodeID,
		SnapshotSequence:  1,
		TotalChunks:       2,
		ContentHash:       beginHash,
		Signature:         h.sign([]byte(beginHash)),
		DataSchemaVersion: dataSchemaVersion,
		Cursors: []SnapshotCursor{
			{OriginID: "origin-e2e", Sequence: 1},
		},
	}
	HandleSnapshotBegin(h.ctx, h.client, mkEnv("snapshot_begin", begin), h.pool)

	chunk1 := SnapshotChunkPayload{
		SnapshotID: snapshotID,
		ChunkIndex: 0,
		RecordType: "file_version",
		Records:    chunk1Records,
	}
	HandleSnapshotChunk(h.ctx, h.client, mkEnv("snapshot_chunk", chunk1), h.pool)

	chunk2 := SnapshotChunkPayload{
		SnapshotID: snapshotID,
		ChunkIndex: 1,
		RecordType: "tombstone",
		Records:    chunk2Records,
	}
	HandleSnapshotChunk(h.ctx, h.client, mkEnv("snapshot_chunk", chunk2), h.pool)

	sess, ok := getRebuildSession(snapshotID)
	require.True(t, ok, "session must be open after BEGIN+CHUNKs")
	return sess
}

func TestSnapshotIngestionIntegration(t *testing.T) {
	t.Run("happy path promotes", func(t *testing.T) {
		h := setupE2E(t)
		sess := h.runSnapshotStreams(t, "snap-happy", "")

		finalHash, err := hashSnapshotRecords(sess.chunkRecords)
		require.NoError(t, err)

		HandleSnapshotEnd(h.ctx, h.client, mkEnv("snapshot_end", SnapshotEndPayload{
			SnapshotID: sess.snapshotID,
			FinalHash:  finalHash,
			Signature:  h.sign([]byte(finalHash)),
		}), h.pool)

		var liveFile int
		require.NoError(t, h.pool.QueryRow(h.ctx,
			`SELECT COUNT(*) FROM files WHERE account_id=$1 AND file_id='chunk-file'`, h.accountID).Scan(&liveFile))
		require.Equal(t, 1, liveFile)
		var tomb int
		require.NoError(t, h.pool.QueryRow(h.ctx,
			`SELECT COUNT(*) FROM tombstones WHERE account_id=$1 AND entity_id='tomb-folder'`, h.accountID).Scan(&tomb))
		require.Equal(t, 1, tomb)
		var staged int
		require.NoError(t, h.pool.QueryRow(h.ctx,
			`SELECT COUNT(*) FROM rebuild_files WHERE account_id=$1`, h.accountID).Scan(&staged))
		require.Equal(t, 0, staged, "staging must be empty after promotion")
	})

	t.Run("content hash mismatch never promotes", func(t *testing.T) {
		h := setupE2E(t)
		// BEGIN advertises a content hash that will not match the streamed data,
		// but END correctly re-hashes the received bytes (signed). The session
		// must abort because recomputed != BEGIN expected_hash.
		sess := h.runSnapshotStreams(t, "snap-corrupt", "bogus-hash")

		realHash, err := hashSnapshotRecords(sess.chunkRecords)
		require.NoError(t, err)
		HandleSnapshotEnd(h.ctx, h.client, mkEnv("snapshot_end", SnapshotEndPayload{
			SnapshotID: sess.snapshotID,
			FinalHash:  realHash,
			Signature:  h.sign([]byte(realHash)),
		}), h.pool)

		var liveFile int
		require.NoError(t, h.pool.QueryRow(h.ctx,
			`SELECT COUNT(*) FROM files WHERE account_id=$1 AND file_id='chunk-file'`, h.accountID).Scan(&liveFile))
		require.Equal(t, 0, liveFile, "corrupted snapshot must not be promoted")
		var staged int
		require.NoError(t, h.pool.QueryRow(h.ctx,
			`SELECT COUNT(*) FROM rebuild_files WHERE account_id=$1`, h.accountID).Scan(&staged))
		require.Equal(t, 0, staged, "abort must clear staging")
	})

	t.Run("out of order chunk aborts", func(t *testing.T) {
		h := setupE2E(t)
		// Open a real session with a valid signed BEGIN (same shape as the
		// happy-path test) so the out-of-order check is what aborts, not an
		// earlier signature-rejection. The content hash is bogus but signed;
		// the chunk ordering check fires before any hash verification.
		beginHash := "bogus-but-signed"
		HandleSnapshotBegin(h.ctx, h.client, mkEnv("snapshot_begin", SnapshotBeginPayload{
			SnapshotID:        "snap-order",
			NodeID:            h.client.NodeID,
			SnapshotSequence:  1,
			TotalChunks:       2,
			ContentHash:       beginHash,
			Signature:         h.sign([]byte(beginHash)),
			DataSchemaVersion: dataSchemaVersion,
		}), h.pool)

		_, ok := getRebuildSession("snap-order")
		require.True(t, ok, "session must be open before the chunk arrives")

		// First chunk must be index 0; sending index 1 first must abort.
		HandleSnapshotChunk(h.ctx, h.client, mkEnv("snapshot_chunk", SnapshotChunkPayload{
			SnapshotID: "snap-order",
			ChunkIndex: 1,
			RecordType: "file_version",
			Records:    []byte(`[{"file_id":"x","version_number":1,"version_hash":"h","shard_count":1}]`),
		}), h.pool)

		_, ok = getRebuildSession("snap-order")
		require.False(t, ok, "session must be removed after out-of-order chunk")
	})

	t.Run("abort marks in-flight rebuild request failed", func(t *testing.T) {
		h := setupE2E(t)
		// Simulate a delivered rebuild request (the status REBUILD_REQUIRED
		// would be recorded as when sent to an online primary).
		mustExec(t, h.pool, `
			INSERT INTO rebuild_requests (account_id, node_id, reason, status)
			VALUES ($1, $2, 'admin', 'delivered')
		`, h.accountID, h.client.NodeID)

		// Hash mismatch (BEGIN hash != streamed data) triggers an abort.
		sess := h.runSnapshotStreams(t, "snap-failreq", "bogus-hash")
		realHash, err := hashSnapshotRecords(sess.chunkRecords)
		require.NoError(t, err)
		HandleSnapshotEnd(h.ctx, h.client, mkEnv("snapshot_end", SnapshotEndPayload{
			SnapshotID: sess.snapshotID,
			FinalHash:  realHash,
			Signature:  h.sign([]byte(realHash)),
		}), h.pool)

		var status string
		require.NoError(t, h.pool.QueryRow(h.ctx,
			`SELECT status FROM rebuild_requests WHERE account_id=$1 AND node_id=$2`,
			h.accountID, h.client.NodeID).Scan(&status))
		require.Equal(t, "failed", status, "aborted rebuild should mark the request as failed")
	})

	t.Run("prune removes only terminal expired requests", func(t *testing.T) {
		h := setupE2E(t)
		old := time.Now().UTC().Add(-91 * 24 * time.Hour)
		recent := time.Now().UTC().Add(-1 * time.Hour)

		mustExec(t, h.pool, `
			INSERT INTO rebuild_requests (account_id, node_id, reason, status, created_at)
			VALUES ($1, $2, 'admin', 'delivered', $3),
			       ($1, $2, 'admin', 'failed', $4),
			       ($1, $2, 'admin', 'pending', $3)
		`, h.accountID, h.client.NodeID, old, recent)

		require.NoError(t, pruneExpiredRebuildRequests(h.ctx, h.pool, 30*24*time.Hour))

		var remaining int
		require.NoError(t, h.pool.QueryRow(h.ctx,
			`SELECT COUNT(*) FROM rebuild_requests WHERE account_id=$1`, h.accountID).Scan(&remaining))
		// The old 'delivered' row is pruned; the recent 'failed' and the
		// old 'pending' survive (pending is never pruned).
		require.Equal(t, 2, remaining, "only terminal rows older than the window are pruned")
	})
}
