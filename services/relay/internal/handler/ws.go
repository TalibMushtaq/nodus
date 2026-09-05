package handler

import (
	"context"
	"encoding/json"
	"log"
	"net/http"

	"github.com/TalibMushtaq/nodus/services/relay/internal/auth"
	"github.com/TalibMushtaq/nodus/services/relay/internal/buffer"
	"github.com/TalibMushtaq/nodus/services/relay/internal/config"
	"github.com/TalibMushtaq/nodus/services/relay/internal/db"
	"github.com/TalibMushtaq/nodus/services/relay/internal/hub"
	"github.com/TalibMushtaq/nodus/services/relay/internal/rdb"
	"github.com/google/uuid"
	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024 * 1024,
	WriteBufferSize: 1024 * 1024,
	CheckOrigin: func(r *http.Request) bool {
		return true // Allow all origins in development
	},
}

// ProtocolEnvelope represents the canonical wire format.
type ProtocolEnvelope struct {
	Type          string          `json:"type"`
	SchemaVersion string          `json:"schema_version"`
	MessageID     string          `json:"message_id"`
	Timestamp     string          `json:"timestamp,omitempty"`
	Payload       json.RawMessage `json:"payload"`
}

type RegisterPayload struct {
	AccountID    string   `json:"account_id"`
	DeviceID     string   `json:"device_id,omitempty"`
	NodeID       string   `json:"node_id,omitempty"`
	PublicKey    string   `json:"public_key"`
	Capabilities []string `json:"capabilities,omitempty"`
}

type HeartbeatPayload struct {
	ID        string `json:"id"`
	Timestamp string `json:"timestamp"`
}

type ShardAckPayload struct {
	FileID        string `json:"file_id"`
	VersionNumber int    `json:"version_number"`
	ShardIndex    int    `json:"shard_index"`
	Status        string `json:"status"` // "verified" | "failed"
	TransferID    string `json:"transfer_id"`
	ErrorMessage  string `json:"error_message,omitempty"`
}

type PendingNotifyPayload struct {
	FileID        string `json:"file_id"`
	VersionNumber int    `json:"version_number"`
	ShardIndex    int    `json:"shard_index"`
	BufferID      string `json:"buffer_id"`
	FetchToken    string `json:"fetch_token"`
	FromDevice    string `json:"from_device"`
	Hash          string `json:"hash"`
	Size          int64  `json:"size"`
}

// WebSocket handles incoming WebSocket connection upgrades and message lifecycle.
func WebSocket(h *hub.Hub, pool *db.Pool, rClient *rdb.Client, buf *buffer.Buffer, cfg *config.Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			log.Printf("[ws] upgrade error: %v", err)
			return
		}

		connID := uuid.NewString()
		client := &hub.Client{
			Hub:    h,
			ConnID: connID,
			Conn:   conn,
			Send:   make(chan []byte, 256),
		}

		// Check if token was provided in query params (?token=...)
		if tokenParam := r.URL.Query().Get("token"); tokenParam != "" {
			if claims, err := auth.ParseAccessToken(cfg, tokenParam); err == nil {
				client.AccountID = claims.AccountID
			}
		}

		// Register client with hub
		h.Register(client)

		// Phase 8: Issue challenge-response nonce for node authentication
		IssueAuthChallenge(r.Context(), client, rClient)

		go client.WritePump()
		go client.ReadPump(func(c *hub.Client, msgType int, payload []byte) {
			if msgType != websocket.TextMessage {
				return
			}

			var env ProtocolEnvelope
			if err := json.Unmarshal(payload, &env); err != nil {
				log.Printf("[ws] invalid JSON from conn=%s: %v", c.ConnID, err)
				return
			}

			handleIncomingEnvelope(c, env, pool, rClient, buf, h)
		})
	}
}

func handleIncomingEnvelope(
	c *hub.Client,
	env ProtocolEnvelope,
	pool *db.Pool,
	rClient *rdb.Client,
	buf *buffer.Buffer,
	h *hub.Hub,
) {
	ctx := context.Background()

	switch env.Type {
	case "node_auth_response":
		HandleNodeAuthResponse(ctx, c, env, pool, rClient, h)

	case "sync_hello":
		HandleSyncHello(ctx, c, env, pool)

	case "event_batch":
		HandleEventBatch(ctx, c, env, pool)

	case "snapshot_begin":
		HandleSnapshotBegin(ctx, c, env, pool)

	case "snapshot_chunk":
		HandleSnapshotChunk(ctx, c, env, pool)

	case "snapshot_end":
		HandleSnapshotEnd(ctx, c, env, pool)

	case "register":
		var reg RegisterPayload
		if err := json.Unmarshal(env.Payload, &reg); err != nil {
			log.Printf("[ws] invalid register payload: %v", err)
			return
		}

		if c.AccountID != "" && c.AccountID != reg.AccountID {
			log.Printf("[ws] account ID mismatch for conn=%s", c.ConnID)
			return
		}

		c.AccountID = reg.AccountID
		c.NodeID = reg.NodeID
		c.DeviceID = reg.DeviceID

		// Re-register with the hub so indexing maps are updated
		h.Register(c)

		// If a node connected, deliver any pending buffered shards
		if c.NodeID != "" && pool != nil {
			go checkAndDeliverPendingShards(ctx, c, pool, rClient)
		}

	case "heartbeat":
		var hb HeartbeatPayload
		if err := json.Unmarshal(env.Payload, &hb); err != nil {
			return
		}

		peerID := hb.ID
		if peerID == "" {
			if c.NodeID != "" {
				peerID = c.NodeID
			} else if c.DeviceID != "" {
				peerID = c.DeviceID
			}
		}

		if peerID != "" {
			h.RefreshPresence(ctx, peerID)
			if c.NodeID != "" && pool != nil {
				_, _ = pool.Exec(ctx, "UPDATE storage_nodes SET last_seen_at = NOW() WHERE node_id = $1", c.NodeID)
			}
		}

	case "shard_ack":
		var ack ShardAckPayload
		if err := json.Unmarshal(env.Payload, &ack); err != nil {
			return
		}

		if pool == nil || buf == nil {
			return
		}
		switch ack.Status {
		case "verified":
			handleShardAckVerified(ctx, c, ack, pool, rClient, buf)
		case "failed":
			handleShardAckFailed(ctx, c, ack, pool, rClient)
		}
	}
}

// checkAndDeliverPendingShards runs when a node (re)connects and registers. It
// walks every shard still in RELAY_BUFFERED for that node and sends a
// pending_notify with a fresh fetch token. Re-issuing the token on reconnect is
// deliberate: a token minted while the node was offline may have expired.
func checkAndDeliverPendingShards(ctx context.Context, c *hub.Client, pool *db.Pool, rClient *rdb.Client) {
	query := `
		SELECT fl.file_id, fl.version_number, fl.shard_index, fl.buffer_id, fl.hash, fl.size_bytes, fl.source_device
		FROM file_locations fl
		WHERE fl.node_id = $1 AND fl.status = 'RELAY_BUFFERED' AND fl.buffer_id IS NOT NULL
	`

	rows, err := pool.Query(ctx, query, c.NodeID)
	if err != nil {
		log.Printf("[ws] error querying pending shards for node=%s: %v", c.NodeID, err)
		return
	}
	defer rows.Close()

	for rows.Next() {
		var (
			fileID        string
			versionNumber int
			shardIndex    int
			bufferID      string
			hash          string
			sizeBytes     int64
			fromDevice    string
		)
		if err := rows.Scan(&fileID, &versionNumber, &shardIndex, &bufferID, &hash, &sizeBytes, &fromDevice); err != nil {
			continue
		}

		envBytes, ok := buildPendingNotifyEnvelope(ctx, rClient, PendingNotifyPayload{
			FileID:        fileID,
			VersionNumber: versionNumber,
			ShardIndex:    shardIndex,
			BufferID:      bufferID,
			FromDevice:    fromDevice,
			Hash:          hash,
			Size:          sizeBytes,
		})
		if !ok {
			continue
		}

		// Backfill runs outside the hub lock, so the client can unregister (and
		// its Send channel close) mid-iteration; safeSend absorbs that race.
		if !safeSend(c.Send, envBytes) {
			log.Printf("[ws] warning: could not send pending_notify to node=%s", c.NodeID)
		}
	}
}

// safeSend enqueues a message without letting a racing hub shutdown crash the
// relay. The hub closes a client's Send channel under its lock on unregister;
// a bare send on a closed channel panics even when written inside a select.
// checkAndDeliverPendingShards runs outside the hub lock (it reads the DB for
// backfill), so the client may be gone by the time a notify is ready — recover
// and drop instead of taking the whole process down.
func safeSend(dst chan []byte, msg []byte) (sent bool) {
	defer func() {
		if recover() != nil {
			sent = false
		}
	}()
	select {
	case dst <- msg:
		return true
	default:
		return false
	}
}

func handleShardAckVerified(
	ctx context.Context,
	c *hub.Client,
	ack ShardAckPayload,
	pool *db.Pool,
	rClient *rdb.Client,
	buf *buffer.Buffer,
) {
	// The node acks "verified" only after it has fetched the bytes, matched the
	// BLAKE3 digest, and committed the shard locally. By then custody has fully
	// transferred, so route NODE_RECEIVING -> NODE_VERIFIED -> NODE_STORED.
	var bufferID *string
	err := pool.QueryRow(ctx, `
		SELECT buffer_id FROM file_locations
		WHERE file_id = $1 AND version_number = $2 AND shard_index = $3 AND node_id = $4
		  AND status = 'NODE_RECEIVING'
	`, ack.FileID, ack.VersionNumber, ack.ShardIndex, c.NodeID).Scan(&bufferID)
	if err != nil {
		// Stale or unknown ack (e.g. duplicate verified after cleanup).
		return
	}

	_, _ = pool.Exec(ctx, `
		UPDATE file_locations SET status = 'NODE_VERIFIED', updated_at = NOW()
		WHERE file_id = $1 AND version_number = $2 AND shard_index = $3 AND node_id = $4
	`, ack.FileID, ack.VersionNumber, ack.ShardIndex, c.NodeID)
	_, _ = pool.Exec(ctx, `
		UPDATE file_locations SET status = 'NODE_STORED', buffer_id = NULL, updated_at = NOW()
		WHERE file_id = $1 AND version_number = $2 AND shard_index = $3 AND node_id = $4
	`, ack.FileID, ack.VersionNumber, ack.ShardIndex, c.NodeID)

	// The node owns the shard now; release the Relay's temporary copy.
	if bufferID != nil && *bufferID != "" {
		if err := buf.Delete(*bufferID); err != nil {
			log.Printf("[relay-buffer] failed to delete buffer file %s: %v", *bufferID, err)
		}
		if rClient != nil {
			_ = rClient.RemovePendingBuffer(ctx, c.NodeID, *bufferID)
		}
		log.Printf("[relay-buffer] shard verified and buffer released: %s (file: %s v%d shard: %d)",
			*bufferID, ack.FileID, ack.VersionNumber, ack.ShardIndex)
	}
}

func handleShardAckFailed(
	ctx context.Context,
	c *hub.Client,
	ack ShardAckPayload,
	pool *db.Pool,
	rClient *rdb.Client,
) {
	// Verification or transfer failed on the node side. Revert the shard to
	// RELAY_BUFFERED and keep the buffer file so it can be delivered on the
	// next reconnect; no automatic redelivery is attempted right now.
	ct, err := pool.Exec(ctx, `
		UPDATE file_locations SET status = 'RELAY_BUFFERED', updated_at = NOW()
		WHERE file_id = $1 AND version_number = $2 AND shard_index = $3 AND node_id = $4
		  AND status = 'NODE_RECEIVING'
	`, ack.FileID, ack.VersionNumber, ack.ShardIndex, c.NodeID)
	if err != nil {
		log.Printf("[relay-buffer] failed to revert shard after node error: %v", err)
		return
	}
	if ct.RowsAffected() > 0 {
		log.Printf("[relay-buffer] shard reverted to RELAY_BUFFERED after failed ack (file: %s v%d shard: %d): %s",
			ack.FileID, ack.VersionNumber, ack.ShardIndex, ack.ErrorMessage)
	}

	// Re-register with the pending set so reconnect-time delivery re-notifies it.
	if rClient != nil {
		var bufferID *string
		err := pool.QueryRow(ctx, `
			SELECT buffer_id FROM file_locations
			WHERE file_id = $1 AND version_number = $2 AND shard_index = $3 AND node_id = $4
		`, ack.FileID, ack.VersionNumber, ack.ShardIndex, c.NodeID).Scan(&bufferID)
		if err == nil && bufferID != nil && *bufferID != "" {
			_ = rClient.AddPendingBuffer(ctx, c.NodeID, *bufferID)
		}
	}
}
