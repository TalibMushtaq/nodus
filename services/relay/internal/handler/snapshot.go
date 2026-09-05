package handler

import (
	"context"
	"crypto/ed25519"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"sync"
	"time"

	"github.com/TalibMushtaq/nodus/services/relay/internal/db"
	"github.com/TalibMushtaq/nodus/services/relay/internal/hub"
)

// ── Data schema version compatibility ──────────────────────────────
// The snapshot carries its own data_schema_version (independent of the message
// envelope version). Only the major version is significant: a different major
// means the Relay cannot interpret the snapshot and must reject it.
const dataSchemaVersion = "1.0"

func dataSchemaCompatible(received string) bool {
	got := received
	if idx := strings.Index(got, "."); idx >= 0 {
		got = got[:idx]
	}
	want := dataSchemaVersion
	if idx := strings.Index(want, "."); idx >= 0 {
		want = want[:idx]
	}
	return got == want
}

// ── Wire payload types (mirror packages/protocol/src/messages/snapshot.ts) ──

type SnapshotCursor struct {
	OriginID string `json:"origin_id"`
	Sequence int64  `json:"sequence"`
}

type SnapshotBeginPayload struct {
	SnapshotID        string           `json:"snapshot_id"`
	NodeID            string           `json:"node_id"`
	SnapshotSequence  int64            `json:"snapshot_sequence"`
	TotalChunks       int64            `json:"total_chunks"`
	ContentHash       string           `json:"content_hash"`
	Signature         string           `json:"signature"`
	DataSchemaVersion string           `json:"data_schema_version"`
	Cursors           []SnapshotCursor `json:"cursors"`
}

type FileVersionRecord struct {
	FileID          string  `json:"file_id"`
	VersionNumber   int64   `json:"version_number"`
	ParentVersionID *int64  `json:"parent_version_id,omitempty"`
	ConflictStatus  *string `json:"conflict_status,omitempty"`
	VersionHash     string  `json:"version_hash"`
	ShardCount      int64   `json:"shard_count"`
	EncryptedName   *string `json:"encrypted_name,omitempty"`
	ParentFolderID  *string `json:"parent_folder_id,omitempty"`
}

type TombstoneRecord struct {
	EntityType string `json:"entity_type"`
	EntityID   string `json:"entity_id"`
	DeletedAt  string `json:"deleted_at"`
}

type SnapshotChunkPayload struct {
	SnapshotID string          `json:"snapshot_id"`
	ChunkIndex int64           `json:"chunk_index"`
	RecordType string          `json:"record_type"`
	Records    json.RawMessage `json:"records"`
}

type SnapshotEndPayload struct {
	SnapshotID string `json:"snapshot_id"`
	FinalHash  string `json:"final_hash"`
	Signature  string `json:"signature"`
}

// ── Rebuild session ────────────────────────────────────────────────
// Tracks an in-progress snapshot transfer from the primary node. Chunks are
// staged into rebuild_* tables as they arrive; promotion to the live tables is
// only attempted after full verification (signature + schema + content hash).

type rebuildSession struct {
	snapshotID        string
	nodeID            string
	accountID         string
	expectedHash      string
	dataSchemaVersion string
	cursors           []SnapshotCursor
	totalChunks       int64
	receivedChunks    int64
	// raw records JSON per chunk, in chunk order, for end-to-end hash check
	chunkRecords [][]byte
	// whether the session is still valid (a failed session rejects further chunks)
	failed   bool
	failedAt time.Time
}

var (
	rebuildSessions   = make(map[string]*rebuildSession)
	rebuildSessionsMu sync.Mutex
)

func getRebuildSession(snapshotID string) (*rebuildSession, bool) {
	rebuildSessionsMu.Lock()
	defer rebuildSessionsMu.Unlock()
	s, ok := rebuildSessions[snapshotID]
	return s, ok
}

func putRebuildSession(s *rebuildSession) {
	rebuildSessionsMu.Lock()
	defer rebuildSessionsMu.Unlock()
	rebuildSessions[s.snapshotID] = s
}

func removeRebuildSession(snapshotID string) {
	rebuildSessionsMu.Lock()
	defer rebuildSessionsMu.Unlock()
	delete(rebuildSessions, snapshotID)
}

// hasActiveSessionForAccount reports whether the account already has a live
// (non-failed) rebuild session. Must hold rebuildSessionsMu while reading the
// shared map, since other goroutines mutate it under the same lock.
func hasActiveSessionForAccount(accountID string) bool {
	rebuildSessionsMu.Lock()
	defer rebuildSessionsMu.Unlock()
	for _, existing := range rebuildSessions {
		if existing.accountID == accountID && !existing.failed {
			return true
		}
	}
	return false
}

// ── Snapshot verification helpers ──────────────────────────────────

// Ed25519-verify `signature` (hex) over `message` bytes against the node's
// registered public key from storage_nodes.
func verifyNodeSignature(ctx context.Context, pool *db.Pool, nodeID string, message []byte, signatureHex string) error {
	var pubKeyHex string
	err := pool.QueryRow(ctx,
		`SELECT public_key FROM storage_nodes WHERE node_id = $1`, nodeID).Scan(&pubKeyHex)
	if err != nil {
		return fmt.Errorf("lookup node public key: %w", err)
	}
	return verifySignatureHex(pubKeyHex, message, signatureHex)
}

// verifySignatureHex verifies a hex-encoded Ed25519 signature over `message`
// against a hex-encoded public key. Split from verifyNodeSignature so it can be
// unit-tested without a database.
func verifySignatureHex(pubKeyHex string, message []byte, signatureHex string) error {
	pubKeyBytes, err := hex.DecodeString(pubKeyHex)
	if err != nil || len(pubKeyBytes) != ed25519.PublicKeySize {
		return fmt.Errorf("invalid node public key format")
	}
	sigBytes, err := hex.DecodeString(signatureHex)
	if err != nil || len(sigBytes) != ed25519.SignatureSize {
		return fmt.Errorf("invalid signature format")
	}
	if !ed25519.Verify(pubKeyBytes, message, sigBytes) {
		return fmt.Errorf("signature verification failed")
	}
	return nil
}

// ── SNAPSHOT_BEGIN: validate metadata, verify signature + schema, open session ──

func HandleSnapshotBegin(ctx context.Context, c *hub.Client, env ProtocolEnvelope, pool *db.Pool) {
	if pool == nil || c.AccountID == "" {
		return
	}

	var begin SnapshotBeginPayload
	if err := json.Unmarshal(env.Payload, &begin); err != nil {
		log.Printf("[snapshot] invalid snapshot_begin payload: %v", err)
		return
	}

	// Only an authenticated storage node acting as the account's primary may
	// serve a rebuild.
	if c.NodeID == "" || c.NodeID != begin.NodeID {
		log.Printf("[snapshot] snapshot_begin node mismatch conn=%s", c.ConnID)
		return
	}

	// Schema version compatibility: reject uninterpretable snapshots.
	if !dataSchemaCompatible(begin.DataSchemaVersion) {
		log.Printf("[snapshot] rejecting snapshot %s with incompatible data schema %q",
			begin.SnapshotID, begin.DataSchemaVersion)
		_ = sendEnvelope(c, "error", map[string]any{
			"correlation_id": env.MessageID,
			"error_code":     "incompatible_version",
			"error_message":  fmt.Sprintf("snapshot data_schema_version %q is incompatible", begin.DataSchemaVersion),
			"retryable":      false,
		})
		return
	}

	// Verify the node's signature over the promised content hash.
	if err := verifyNodeSignature(ctx, pool, begin.NodeID, []byte(begin.ContentHash), begin.Signature); err != nil {
		log.Printf("[snapshot] rejecting snapshot %s: %v", begin.SnapshotID, err)
		_ = sendEnvelope(c, "error", map[string]any{
			"correlation_id": env.MessageID,
			"error_code":     "auth_failed",
			"error_message":  "snapshot signature verification failed",
			"retryable":      false,
		})
		return
	}

	// Confirm this node is the account's designated primary.
	var isPrimary bool
	err := pool.QueryRow(ctx,
		`SELECT is_primary FROM storage_nodes WHERE node_id = $1 AND account_id = $2`,
		begin.NodeID, c.AccountID).Scan(&isPrimary)
	if err != nil || !isPrimary {
		log.Printf("[snapshot] rejecting snapshot %s: node %s is not the account primary",
			begin.SnapshotID, begin.NodeID)
		_ = sendEnvelope(c, "error", map[string]any{
			"correlation_id": env.MessageID,
			"error_code":     "auth_failed",
			"error_message":  "only the primary storage node may serve a rebuild",
			"retryable":      false,
		})
		return
	}

	// Drop any stale session for the same snapshot id (e.g. re-sent BEGIN),
	// but refuse a second concurrent rebuild for the same account. Single-flight
	// per account keeps an aborted session's partial staging from ever being
	// promoted by a later, unrelated session: abort clears the account's
	// rebuild_* tables, so another in-flight session would lose its data.
	if hasActiveSessionForAccount(c.AccountID) {
		log.Printf("[snapshot] rejecting snapshot %s: rebuild already in flight for account %s",
			begin.SnapshotID, c.AccountID)
		_ = sendEnvelope(c, "error", map[string]any{
			"correlation_id": env.MessageID,
			"error_code":     "rebuild_in_progress",
			"error_message":  "a rebuild is already in progress for this account",
			"retryable":      true,
		})
		return
	}
	removeRebuildSession(begin.SnapshotID)

	sess := &rebuildSession{
		snapshotID:        begin.SnapshotID,
		nodeID:            begin.NodeID,
		accountID:         c.AccountID,
		expectedHash:      begin.ContentHash,
		dataSchemaVersion: begin.DataSchemaVersion,
		cursors:           begin.Cursors,
		totalChunks:       begin.TotalChunks,
	}
	putRebuildSession(sess)

	log.Printf("[snapshot] session opened: snapshot=%s node=%s chunks=%d seq=%d",
		begin.SnapshotID, begin.NodeID, begin.TotalChunks, begin.SnapshotSequence)
}

// ── SNAPSHOT_CHUNK: validate ordering/idempotency, stage rows, accumulate hash ──

func HandleSnapshotChunk(ctx context.Context, c *hub.Client, env ProtocolEnvelope, pool *db.Pool) {
	if pool == nil || c.AccountID == "" {
		return
	}

	var chunk SnapshotChunkPayload
	if err := json.Unmarshal(env.Payload, &chunk); err != nil {
		log.Printf("[snapshot] invalid snapshot_chunk payload: %v", err)
		return
	}

	sess, ok := getRebuildSession(chunk.SnapshotID)
	if !ok || sess.failed {
		return
	}

	// Chunk must come from the same node that opened the session.
	if c.NodeID != sess.nodeID {
		log.Printf("[snapshot] chunk node mismatch for snapshot %s", chunk.SnapshotID)
		return
	}

	// Ordering check: chunks must arrive in index order starting at 0, with no
	// gaps or duplicates. Re-assembly at 1000-record boundaries depends on it.
	if chunk.ChunkIndex != sess.receivedChunks {
		log.Printf("[snapshot] aborting snapshot %s: out-of-order chunk %d (expected %d)",
			chunk.SnapshotID, chunk.ChunkIndex, sess.receivedChunks)
		abortRebuildSession(ctx, pool, sess, "out-of-order chunk")
		return
	}

	// Accumulate raw records for the end-to-end hash check. The node hashes
	// each chunk as [8-byte BE record count] ++ [compact JSON records array],
	// so we hash the exact bytes we received to avoid serializer divergence.
	sess.chunkRecords = append(sess.chunkRecords, append([]byte(nil), chunk.Records...))
	sess.receivedChunks++

	// Stage rows into the rebuild_* tables as they stream in.
	if err := stageRebuildChunk(ctx, pool, c.AccountID, &chunk); err != nil {
		log.Printf("[snapshot] aborting snapshot %s: staging error: %v", chunk.SnapshotID, err)
		abortRebuildSession(ctx, pool, sess, err.Error())
		return
	}
}

// stageRebuildChunk upserts one snapshot chunk's records into the matching
// rebuild_* staging table. File versions also backfill the rebuild_files rows
// (the file catalog is derived from version records; timestamps default to now).
func stageRebuildChunk(ctx context.Context, pool *db.Pool, accountID string, chunk *SnapshotChunkPayload) error {
	switch chunk.RecordType {
	case "file_version":
		var records []FileVersionRecord
		if err := json.Unmarshal(chunk.Records, &records); err != nil {
			return fmt.Errorf("invalid file_version records: %w", err)
		}
		tx, err := pool.Begin(ctx)
		if err != nil {
			return err
		}
		defer tx.Rollback(ctx) //nolint:errcheck
		for _, r := range records {
			if _, err := tx.Exec(ctx, `
				INSERT INTO rebuild_files (file_id, account_id, parent_folder_id, encrypted_name, created_at, updated_at)
				VALUES ($1, $2, $3, $4, NOW(), NOW())
				ON CONFLICT (file_id) DO NOTHING
			`, r.FileID, accountID, r.ParentFolderID, r.EncryptedName); err != nil {
				return err
			}
			conflictStatus := "none"
			if r.ConflictStatus != nil && *r.ConflictStatus != "" {
				conflictStatus = *r.ConflictStatus
			}
			if _, err := tx.Exec(ctx, `
				INSERT INTO rebuild_file_versions (file_id, account_id, version_number, parent_version_id, conflict_status, version_hash, shard_count, created_at)
				VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
				ON CONFLICT (file_id, version_number) DO UPDATE SET
					parent_version_id = EXCLUDED.parent_version_id,
					conflict_status = EXCLUDED.conflict_status,
					version_hash = EXCLUDED.version_hash,
					shard_count = EXCLUDED.shard_count
			`, r.FileID, accountID, r.VersionNumber, r.ParentVersionID, conflictStatus, r.VersionHash, r.ShardCount); err != nil {
				return err
			}
		}
		return tx.Commit(ctx)

	case "tombstone":
		var records []TombstoneRecord
		if err := json.Unmarshal(chunk.Records, &records); err != nil {
			return fmt.Errorf("invalid tombstone records: %w", err)
		}
		for _, r := range records {
			// deleted_at is RFC3339; relay stores timestamptz.
			deletedAt, err := time.Parse(time.RFC3339, r.DeletedAt)
			if err != nil {
				return fmt.Errorf("invalid tombstone deleted_at %q: %w", r.DeletedAt, err)
			}
			if _, err := pool.Exec(ctx, `
				INSERT INTO rebuild_tombstones (account_id, entity_type, entity_id, deleted_at)
				VALUES ($1, $2, $3, $4)
				ON CONFLICT (account_id, entity_type, entity_id) DO UPDATE SET deleted_at = EXCLUDED.deleted_at
			`, accountID, r.EntityType, r.EntityID, deletedAt); err != nil {
				return err
			}
		}
		return nil
	}
	return fmt.Errorf("unknown record_type %q", chunk.RecordType)
}

// ── SNAPSHOT_END: verify final hash, then atomically promote ───────

func HandleSnapshotEnd(ctx context.Context, c *hub.Client, env ProtocolEnvelope, pool *db.Pool) {
	if pool == nil || c.AccountID == "" {
		return
	}

	var end SnapshotEndPayload
	if err := json.Unmarshal(env.Payload, &end); err != nil {
		log.Printf("[snapshot] invalid snapshot_end payload: %v", err)
		return
	}

	sess, ok := getRebuildSession(end.SnapshotID)
	if !ok || sess.failed {
		return
	}
	if c.NodeID != sess.nodeID {
		return
	}

	// 1. Verify the END signature over final_hash.
	if err := verifyNodeSignature(ctx, pool, sess.nodeID, []byte(end.FinalHash), end.Signature); err != nil {
		log.Printf("[snapshot] aborting snapshot %s: end signature failed: %v", end.SnapshotID, err)
		abortRebuildSession(ctx, pool, sess, "end signature verification failed")
		return
	}

	// 2. Recompute the cumulative content hash from the raw received chunk bytes.
	if sess.receivedChunks != sess.totalChunks {
		log.Printf("[snapshot] aborting snapshot %s: got %d/%d chunks",
			end.SnapshotID, sess.receivedChunks, sess.totalChunks)
		abortRebuildSession(ctx, pool, sess, "chunk count mismatch")
		return
	}
	recomputed, err := hashSnapshotRecords(sess.chunkRecords)
	if err != nil {
		abortRebuildSession(ctx, pool, sess, "hash recompute failed")
		return
	}
	if recomputed != end.FinalHash || recomputed != sess.expectedHash {
		log.Printf("[snapshot] aborting snapshot %s: content hash mismatch (got %s, end %s, begin %s)",
			end.SnapshotID, recomputed, end.FinalHash, sess.expectedHash)
		abortRebuildSession(ctx, pool, sess, "content hash mismatch")
		return
	}

	// 3. Verification passed — atomically promote staged state.
	if err := promoteRebuild(ctx, pool, sess); err != nil {
		log.Printf("[snapshot] rebuild promote failed for snapshot %s: %v", end.SnapshotID, err)
		abortRebuildSession(ctx, pool, sess, err.Error())
		_ = sendEnvelope(c, "error", map[string]any{
			"correlation_id": env.MessageID,
			"error_code":     "internal_error",
			"error_message":  "rebuild promotion failed",
			"retryable":      true,
		})
		return
	}

	// 4. Mark any queued rebuild request for this account/node as delivered.
	_, _ = pool.Exec(ctx, `
		UPDATE rebuild_requests SET status = 'delivered', delivered_at = NOW()
		WHERE account_id = $1 AND node_id = $2 AND status = 'pending'
	`, sess.accountID, sess.nodeID)

	removeRebuildSession(end.SnapshotID)
	log.Printf("[snapshot] rebuild complete: account=%s node=%s snapshot=%s chunks=%d",
		sess.accountID, sess.nodeID, end.SnapshotID, sess.receivedChunks)
}

// abortRebuildSession marks the session failed so later chunks are ignored,
// removes the session, clears the account's staged rebuild_* rows so a partial
// transfer can never be promoted by a later session, and marks any in-flight
// rebuild request for this node as 'failed' so operators can see the outcome.
func abortRebuildSession(ctx context.Context, pool *db.Pool, sess *rebuildSession, reason string) {
	sess.failed = true
	sess.failedAt = time.Now()
	log.Printf("[snapshot] rebuild aborted: snapshot=%s node=%s reason=%s",
		sess.snapshotID, sess.nodeID, reason)
	removeRebuildSession(sess.snapshotID)
	if pool != nil {
		cleanupStagedData(ctx, pool, sess.accountID)
		// The request was already flipped to 'delivered' when REBUILD_REQUIRED
		// was sent; single-flight guarantees at most one such row per node, so
		// flipping the most recent 'delivered' one to 'failed' is unambiguous.
		_, _ = pool.Exec(ctx, `
			UPDATE rebuild_requests SET status = 'failed'
			WHERE account_id = $1 AND node_id = $2 AND status = 'delivered'
		`, sess.accountID, sess.nodeID)
	}
}

// hashSnapshotRecords recomputes the BLAKE3 content hash exactly as the Rust
// node does: for each chunk in order, [8-byte big-endian record count] ++
// [compact JSON records array bytes]. Returns lowercase hex.
func hashSnapshotRecords(chunks [][]byte) (string, error) {
	hasher := blake3Hasher()
	for _, records := range chunks {
		var countBuf [8]byte
		// Record count = number of JSON array elements, parsed from the raw bytes.
		var arr []json.RawMessage
		if err := json.Unmarshal(records, &arr); err != nil {
			return "", err
		}
		binary.BigEndian.PutUint64(countBuf[:], uint64(len(arr)))
		hasher.Write(countBuf[:])
		hasher.Write(records)
	}
	return hex.EncodeToString(hasher.Sum(nil)), nil
}
