package handler

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"time"

	"github.com/TalibMushtaq/nodus/services/relay/internal/db"
	"github.com/TalibMushtaq/nodus/services/relay/internal/hub"
	"github.com/TalibMushtaq/nodus/services/relay/internal/rdb"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type NodeAuthChallengePayload struct {
	Nonce string `json:"nonce"`
}

type NodeAuthResponsePayload struct {
	NodeID    string `json:"node_id"`
	Signature string `json:"signature"`
}

type NodeAuthResultPayload struct {
	Status  string `json:"status"` // "ok" | "fail"
	Message string `json:"message,omitempty"`
	Reason  string `json:"reason,omitempty"`
}

type SyncCursor struct {
	OriginID string `json:"origin_id"`
	Sequence int64  `json:"sequence"`
}

type SyncCursorWithCount struct {
	OriginID   string `json:"origin_id"`
	Sequence   int64  `json:"sequence"`
	KnownCount int64  `json:"known_count"`
}

type SyncHelloPayload struct {
	NodeID  string       `json:"node_id"`
	Cursors []SyncCursor `json:"cursors"`
}

type SyncStatusPayload struct {
	NodeID  string                `json:"node_id"`
	Cursors []SyncCursorWithCount `json:"cursors"`
}

type SyncEventItem struct {
	EventID        string          `json:"event_id"`
	OriginID       string          `json:"origin_id"`
	OriginSequence int64           `json:"origin_sequence"`
	Type           string          `json:"type"`
	Payload        json.RawMessage `json:"payload"`
	Timestamp      string          `json:"timestamp"`
}

type EventBatchPayload struct {
	Events []SyncEventItem `json:"events"`
}

type BatchAckPayload struct {
	BatchID         string   `json:"batch_id,omitempty"`
	AppliedEventIDs []string `json:"applied_event_ids"`
}

type FileVersionEventData struct {
	FileID          string  `json:"file_id"`
	VersionNumber   int     `json:"version_number"`
	ParentVersionID *int    `json:"parent_version_id,omitempty"`
	ConflictStatus  *string `json:"conflict_status,omitempty"`
	ShardCount      int     `json:"shard_count"`
	VersionHash     string  `json:"version_hash"`
	EncryptedName   *string `json:"encrypted_name,omitempty"`
	ParentFolderID  *string `json:"parent_folder_id,omitempty"`
}

type FileCreatedEventData struct {
	FileID         string  `json:"file_id"`
	ParentFolderID *string `json:"parent_folder_id,omitempty"`
	EncryptedName  *string `json:"encrypted_name,omitempty"`
}

func sendEnvelope(c *hub.Client, msgType string, payload any) error {
	payloadBytes, err := json.Marshal(payload)
	if err != nil {
		return err
	}

	env := ProtocolEnvelope{
		Type:          msgType,
		SchemaVersion: "1.0.0",
		MessageID:     uuid.NewString(),
		Timestamp:     time.Now().UTC().Format(time.RFC3339),
		Payload:       payloadBytes,
	}

	envBytes, err := json.Marshal(env)
	if err != nil {
		return err
	}

	select {
	case c.Send <- envBytes:
		return nil
	default:
		return fmt.Errorf("client send buffer full for conn=%s", c.ConnID)
	}
}

// IssueAuthChallenge generates a cryptographically random nonce and sends it to the connecting peer.
func IssueAuthChallenge(ctx context.Context, c *hub.Client, rClient *rdb.Client) {
	nonceBytes := make([]byte, 32)
	if _, err := rand.Read(nonceBytes); err != nil {
		log.Printf("[ws] error generating auth nonce: %v", err)
		return
	}
	nonce := hex.EncodeToString(nonceBytes)

	c.AuthNonce = nonce
	c.AuthNonceExpiry = time.Now().Add(30 * time.Second)

	if rClient != nil {
		if err := rClient.SetAuthNonce(ctx, c.ConnID, nonce, 30*time.Second); err != nil {
			log.Printf("[ws] error saving nonce in redis: %v", err)
		}
	}

	if err := sendEnvelope(c, "node_auth_challenge", NodeAuthChallengePayload{Nonce: nonce}); err != nil {
		log.Printf("[ws] error sending node_auth_challenge: %v", err)
	}
}

// HandleNodeAuthResponse verifies the challenge response signature and authenticates the node.
func HandleNodeAuthResponse(
	ctx context.Context,
	c *hub.Client,
	env ProtocolEnvelope,
	pool *db.Pool,
	rClient *rdb.Client,
	h *hub.Hub,
) {
	if c.IsAuthenticated {
		_ = sendEnvelope(c, "node_auth_result", NodeAuthResultPayload{
			Status:  "fail",
			Message: "connection is already authenticated",
		})
		return
	}
	var resp NodeAuthResponsePayload
	if err := json.Unmarshal(env.Payload, &resp); err != nil {
		_ = sendEnvelope(c, "node_auth_result", NodeAuthResultPayload{
			Status:  "fail",
			Message: "invalid auth response payload",
		})
		return
	}

	if resp.NodeID == "" || resp.Signature == "" {
		_ = sendEnvelope(c, "node_auth_result", NodeAuthResultPayload{
			Status:  "fail",
			Message: "missing node_id or signature",
		})
		return
	}

	// 1. Verify and consume nonce (enforces single-use and 30s TTL)
	nonceValid := false
	expectedNonce := c.AuthNonce

	if rClient != nil {
		consumed, err := rClient.ConsumeAuthNonce(ctx, c.ConnID, expectedNonce)
		if err == nil && consumed {
			nonceValid = true
		}
	} else {
		// Memory fallback when Redis is absent
		if c.AuthNonce != "" && time.Now().Before(c.AuthNonceExpiry) {
			nonceValid = true
		}
	}
	// Always clear local nonce to enforce single-use
	c.AuthNonce = ""

	if !nonceValid || expectedNonce == "" {
		_ = sendEnvelope(c, "node_auth_result", NodeAuthResultPayload{
			Status:  "fail",
			Message: "challenge nonce expired or invalid",
		})
		return
	}

	// 2. Fetch node public key from PostgreSQL
	if pool == nil {
		_ = sendEnvelope(c, "node_auth_result", NodeAuthResultPayload{
			Status:  "fail",
			Message: "database unavailable",
		})
		return
	}

	var (
		accountID string
		pubKeyHex string
		status    string
	)
	query := `SELECT account_id, public_key, status FROM storage_nodes WHERE node_id = $1`
	err := pool.QueryRow(ctx, query, resp.NodeID).Scan(&accountID, &pubKeyHex, &status)
	if err != nil || status != "ACTIVE" {
		_ = sendEnvelope(c, "node_auth_result", NodeAuthResultPayload{
			Status:  "fail",
			Message: "storage node not found or inactive",
			Reason:  "node_not_found",
		})
		return
	}

	// 3. Verify signature over exact challenge nonce bytes
	pubKeyBytes, err := hex.DecodeString(pubKeyHex)
	if err != nil || len(pubKeyBytes) != ed25519.PublicKeySize {
		_ = sendEnvelope(c, "node_auth_result", NodeAuthResultPayload{
			Status:  "fail",
			Message: "invalid node public key format",
		})
		return
	}

	sigBytes, err := hex.DecodeString(resp.Signature)
	if err != nil || len(sigBytes) != ed25519.SignatureSize {
		_ = sendEnvelope(c, "node_auth_result", NodeAuthResultPayload{
			Status:  "fail",
			Message: "invalid signature format",
		})
		return
	}

	// Challenge signature is over the exact nonce bytes
	if !ed25519.Verify(pubKeyBytes, []byte(expectedNonce), sigBytes) {
		_ = sendEnvelope(c, "node_auth_result", NodeAuthResultPayload{
			Status:  "fail",
			Message: "signature verification failed",
		})
		return
	}

	// 4. Authenticated successfully
	c.AccountID = accountID
	c.NodeID = resp.NodeID
	c.IsAuthenticated = true
	h.Register(c)

	_, _ = pool.Exec(ctx, "UPDATE storage_nodes SET last_seen_at = NOW() WHERE node_id = $1", c.NodeID)

	// Phase 9: deliver any queued rebuild requests if this node is the primary.
	deliverPendingRebuildRequests(ctx, pool, h, c.AccountID, c.NodeID)

	_ = sendEnvelope(c, "node_auth_result", NodeAuthResultPayload{
		Status: "ok",
	})
	log.Printf("[ws] node %s successfully authenticated for account %s", c.NodeID, c.AccountID)
}

// HandleSyncHello processes SYNC_HELLO from the node and responds with SYNC_STATUS + missing events.
func HandleSyncHello(
	ctx context.Context,
	c *hub.Client,
	env ProtocolEnvelope,
	pool *db.Pool,
) {
	if pool == nil || c.AccountID == "" {
		return
	}

	var hello SyncHelloPayload
	if err := json.Unmarshal(env.Payload, &hello); err != nil {
		log.Printf("[sync] invalid sync_hello payload: %v", err)
		return
	}

	// 1. Gather all known origin cursors for this account
	query := `
		SELECT origin_id, MAX(origin_sequence) AS max_seq, COUNT(*) AS cnt
		FROM sync_events
		WHERE account_id = $1
		GROUP BY origin_id
	`
	rows, err := pool.Query(ctx, query, c.AccountID)
	if err != nil {
		log.Printf("[sync] error querying sync_events: %v", err)
		return
	}
	defer rows.Close()

	relayCursors := make([]SyncCursorWithCount, 0)
	relayMaxSeq := make(map[string]int64)

	for rows.Next() {
		var (
			originID string
			maxSeq   int64
			cnt      int64
		)
		if err := rows.Scan(&originID, &maxSeq, &cnt); err == nil {
			relayCursors = append(relayCursors, SyncCursorWithCount{
				OriginID:   originID,
				Sequence:   maxSeq,
				KnownCount: cnt,
			})
			relayMaxSeq[originID] = maxSeq
		}
	}

	// 2. Respond with SYNC_STATUS
	_ = sendEnvelope(c, "sync_status", SyncStatusPayload{
		NodeID:  c.NodeID,
		Cursors: relayCursors,
	})

	// 3. Send missing events from Relay to Node
	nodeSeen := make(map[string]int64)
	for _, cur := range hello.Cursors {
		nodeSeen[cur.OriginID] = cur.Sequence
	}

	for originID, maxSeq := range relayMaxSeq {
		seen := nodeSeen[originID]
		if maxSeq > seen {
			sendMissingEventsToNode(ctx, c, pool, originID, seen)
		}
	}
}

func sendMissingEventsToNode(
	ctx context.Context,
	c *hub.Client,
	pool *db.Pool,
	originID string,
	afterSeq int64,
) {
	query := `
		SELECT event_id, origin_id, origin_sequence, event_type, payload, timestamp
		FROM sync_events
		WHERE account_id = $1 AND origin_id = $2 AND origin_sequence > $3
		ORDER BY origin_sequence ASC
		LIMIT 500
	`
	rows, err := pool.Query(ctx, query, c.AccountID, originID, afterSeq)
	if err != nil {
		return
	}
	defer rows.Close()

	events := make([]SyncEventItem, 0)
	for rows.Next() {
		var (
			item       SyncEventItem
			payloadRaw []byte
			ts         time.Time
		)
		if err := rows.Scan(
			&item.EventID,
			&item.OriginID,
			&item.OriginSequence,
			&item.Type,
			&payloadRaw,
			&ts,
		); err == nil {
			item.Payload = payloadRaw
			item.Timestamp = ts.UTC().Format(time.RFC3339)
			events = append(events, item)
		}
	}

	if len(events) > 0 {
		_ = sendEnvelope(c, "event_batch", EventBatchPayload{
			Events: events,
		})
	}
}

// HandleEventBatch applies an incoming batch of events idempotently with conflict detection.
func HandleEventBatch(
	ctx context.Context,
	c *hub.Client,
	env ProtocolEnvelope,
	pool *db.Pool,
) {
	if pool == nil || c.AccountID == "" {
		return
	}

	var batch EventBatchPayload
	if err := json.Unmarshal(env.Payload, &batch); err != nil {
		log.Printf("[sync] invalid event_batch payload: %v", err)
		return
	}

	appliedIDs := make([]string, 0, len(batch.Events))

	for _, item := range batch.Events {
		applied := applySingleEvent(ctx, pool, c.AccountID, item)
		if applied {
			appliedIDs = append(appliedIDs, item.EventID)
		}
	}

	// Always send BATCH_ACK with all successfully processed/already-applied events
	_ = sendEnvelope(c, "batch_ack", BatchAckPayload{
		AppliedEventIDs: appliedIDs,
	})
}

func applySingleEvent(
	ctx context.Context,
	pool *db.Pool,
	accountID string,
	item SyncEventItem,
) bool {
	tx, err := pool.Begin(ctx)
	if err != nil {
		log.Printf("[sync] begin event transaction %s: %v", item.EventID, err)
		return false
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	// Validate file ownership before recording the event. Otherwise a rejected
	// foreign-file event would be journaled and every retry would be treated as
	// already applied even though its projection was never made.
	foreign, err := eventReferencesForeignFile(ctx, tx, accountID, item)
	if err != nil {
		log.Printf("[sync] checking file ownership for event %s: %v", item.EventID, err)
		return false
	}
	if foreign {
		log.Printf("[sync] rejecting %s for a foreign file from account %s", item.Type, accountID)
		return false
	}

	// 1. Idempotency check by account-scoped (origin_id, origin_sequence) or
	// event_id. Phase 14a audit (V3): the check used to be global, letting one
	// account pre-insert a poison row on another account's origin/sequence and
	// swallow its real event (mirrors the 007 migration that scopes the unique
	// constraint to (account_id, origin_id, origin_sequence)).
	var exists bool
	checkQuery := `
		SELECT EXISTS(
			SELECT 1 FROM sync_events 
			WHERE account_id = $4 AND ((origin_id = $1 AND origin_sequence = $2) OR event_id = $3)
		)
	`
	if err := tx.QueryRow(ctx, checkQuery, item.OriginID, item.OriginSequence, item.EventID, accountID).Scan(&exists); err != nil {
		log.Printf("[sync] idempotency check for event %s: %v", item.EventID, err)
		return false
	}
	if exists {
		// Already applied: return true so it's included in BATCH_ACK
		return true
	}

	// 2. Parse timestamp
	t, err := time.Parse(time.RFC3339, item.Timestamp)
	if err != nil {
		t = time.Now().UTC()
	}

	// 3. Insert into sync_events
	insertQuery := `
		INSERT INTO sync_events (event_id, account_id, origin_id, origin_sequence, event_type, payload, timestamp)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		ON CONFLICT (account_id, origin_id, origin_sequence) DO NOTHING
	`
	result, err := tx.Exec(ctx, insertQuery, item.EventID, accountID, item.OriginID, item.OriginSequence, item.Type, item.Payload, t)
	if err != nil {
		log.Printf("[sync] error inserting sync_event %s: %v", item.EventID, err)
		return false
	}
	// Another connection may have inserted the same account/origin/sequence
	// after our read. Its event owns the projection; never apply this payload.
	if result.RowsAffected() == 0 {
		return true
	}

	// 4. Domain entity projections
	switch item.Type {
	case "FILE_CREATED":
		var data FileCreatedEventData
		if err := json.Unmarshal(item.Payload, &data); err == nil && data.FileID != "" {
			// Phase 14a audit (V3): file_id is globally unique, so an upsert
			// could otherwise overwrite another account's file metadata. The
			// WHERE clause makes the update a no-op for a foreign row while the
			// insert still creates the file under the sender's account.
			upsertFile := `
				INSERT INTO files (file_id, account_id, parent_folder_id, encrypted_name, created_at, updated_at)
				VALUES ($1, $2, $3, $4, $5, $5)
				ON CONFLICT (file_id) DO UPDATE SET
					parent_folder_id = EXCLUDED.parent_folder_id,
					encrypted_name = EXCLUDED.encrypted_name,
					updated_at = EXCLUDED.updated_at
				WHERE files.account_id = EXCLUDED.account_id
			`
			result, err := tx.Exec(ctx, upsertFile, data.FileID, accountID, data.ParentFolderID, data.EncryptedName, t)
			if err != nil || result.RowsAffected() == 0 {
				return false
			}
		}

	case "FILE_VERSION_ADDED", "FILE_MODIFIED":
		var data FileVersionEventData
		if err := json.Unmarshal(item.Payload, &data); err == nil && data.FileID != "" {
			// Ensure parent file record exists
			if _, err := tx.Exec(ctx, `
				INSERT INTO files (file_id, account_id, created_at, updated_at)
				VALUES ($1, $2, $3, $3)
				ON CONFLICT (file_id) DO NOTHING
			`, data.FileID, accountID, t); err != nil {
				return false
			}

			// Phase 14a audit (V3): file_versions has no account column, so
			// before writing versions/conflict flags for this file do an explicit
			// ownership check. A foreign file (created here takes DO NOTHING
			// if the id is taken) must not be touched by another account.
			var owner string
			if err := tx.QueryRow(ctx,
				`SELECT account_id FROM files WHERE file_id = $1`, data.FileID).Scan(&owner); err != nil || owner != accountID {
				log.Printf("[sync] rejecting %s for foreign file %s from account %s", item.Type, data.FileID, accountID)
				return false
			}

			// Conflict detection:
			// Check if any existing version shares the same (file_id, parent_version_id) but has a different version_number
			conflictStatus := "none"
			if data.ConflictStatus != nil && *data.ConflictStatus != "" {
				conflictStatus = *data.ConflictStatus
			}

			if data.ParentVersionID != nil {
				var conflictFound bool
				conflictCheck := `
					SELECT EXISTS(
						SELECT 1 FROM file_versions
						WHERE file_id = $1 AND parent_version_id = $2 AND version_number != $3
					)
				`
				if err := tx.QueryRow(ctx, conflictCheck, data.FileID, *data.ParentVersionID, data.VersionNumber).Scan(&conflictFound); err != nil {
					return false
				}

				if conflictFound {
					conflictStatus = "flagged"
					// Symmetrically mark BOTH conflicting versions as flagged
					if _, err := tx.Exec(ctx, `
						UPDATE file_versions
						SET conflict_status = 'flagged'
						WHERE file_id = $1 AND parent_version_id = $2
					`, data.FileID, *data.ParentVersionID); err != nil {
						return false
					}
				}
			}

			insertVersion := `
				INSERT INTO file_versions (file_id, version_number, parent_version_id, conflict_status, version_hash, shard_count, created_at)
				VALUES ($1, $2, $3, $4, $5, $6, $7)
				ON CONFLICT (file_id, version_number) DO UPDATE SET
					parent_version_id = EXCLUDED.parent_version_id,
					conflict_status = EXCLUDED.conflict_status,
					version_hash = EXCLUDED.version_hash,
					shard_count = EXCLUDED.shard_count
			`
			if _, err := tx.Exec(ctx, insertVersion, data.FileID, data.VersionNumber, data.ParentVersionID, conflictStatus, data.VersionHash, data.ShardCount, t); err != nil {
				return false
			}
		}

	case "FILE_DELETED", "TOMBSTONE_CREATED":
		var tData struct {
			EntityID   string `json:"entity_id"`
			EntityType string `json:"entity_type"`
		}
		if err := json.Unmarshal(item.Payload, &tData); err == nil && tData.EntityID != "" {
			if tData.EntityType == "" {
				tData.EntityType = "file"
			}
			if _, err := tx.Exec(ctx, `
				INSERT INTO tombstones (account_id, entity_type, entity_id, deleted_at)
				VALUES ($1, $2, $3, $4)
				ON CONFLICT (account_id, entity_type, entity_id) DO NOTHING
			`, accountID, tData.EntityType, tData.EntityID, t); err != nil {
				return false
			}
		}
	}

	// 5. Update cursor
	if _, err := tx.Exec(ctx, `
		INSERT INTO sync_cursors (account_id, peer_id, last_sequence, updated_at)
		VALUES ($1, $2, $3, NOW())
		ON CONFLICT (account_id, peer_id) DO UPDATE SET
			last_sequence = GREATEST(sync_cursors.last_sequence, EXCLUDED.last_sequence),
			updated_at = NOW()
	`, accountID, item.OriginID, item.OriginSequence); err != nil {
		return false
	}

	if err := tx.Commit(ctx); err != nil {
		log.Printf("[sync] commit event %s: %v", item.EventID, err)
		return false
	}
	return true
}

// eventReferencesForeignFile checks the global file identifier only for event
// types that project into files/file_versions. File IDs are globally unique in
// the live schema, so accepting another account's ID would either mutate its
// projection or leave an acknowledged event with no projection at all.
func eventReferencesForeignFile(ctx context.Context, tx pgx.Tx, accountID string, item SyncEventItem) (bool, error) {
	var fileID string
	switch item.Type {
	case "FILE_CREATED":
		var data FileCreatedEventData
		if err := json.Unmarshal(item.Payload, &data); err != nil || data.FileID == "" {
			return false, nil
		}
		fileID = data.FileID
	case "FILE_VERSION_ADDED", "FILE_MODIFIED":
		var data FileVersionEventData
		if err := json.Unmarshal(item.Payload, &data); err != nil || data.FileID == "" {
			return false, nil
		}
		fileID = data.FileID
	default:
		return false, nil
	}

	var foreign bool
	err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM files WHERE file_id = $1 AND account_id <> $2)`, fileID, accountID).Scan(&foreign)
	return foreign, err
}
