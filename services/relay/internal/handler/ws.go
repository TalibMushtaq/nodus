package handler

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"github.com/TalibMushtaq/nodus/services/relay/internal/auth"
	"github.com/TalibMushtaq/nodus/services/relay/internal/buffer"
	"github.com/TalibMushtaq/nodus/services/relay/internal/config"
	"github.com/TalibMushtaq/nodus/services/relay/internal/db"
	"github.com/TalibMushtaq/nodus/services/relay/internal/hub"
	"github.com/TalibMushtaq/nodus/services/relay/internal/rdb"
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
	FileID       string `json:"file_id"`
	ShardIndex   int    `json:"shard_index"`
	Status       string `json:"status"` // "received" | "verified" | "failed"
	TransferID   string `json:"transfer_id"`
	ErrorMessage string `json:"error_message,omitempty"`
}

type PendingNotifyPayload struct {
	FileID     string `json:"file_id"`
	ShardIndex int    `json:"shard_index"`
	BufferID   string `json:"buffer_id"`
	FromDevice string `json:"from_device"`
	Hash       string `json:"hash"`
	Size       int64  `json:"size"`
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

		if ack.Status == "verified" && pool != nil && buf != nil {
			handleShardAckVerified(ctx, c, ack, pool, rClient, buf)
		}
	}
}

func checkAndDeliverPendingShards(ctx context.Context, c *hub.Client, pool *db.Pool, rClient *rdb.Client) {
	query := `
		SELECT fl.file_id, fl.shard_index, fl.buffer_id
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
			fileID     string
			shardIndex int
			bufferID   string
		)
		if err := rows.Scan(&fileID, &shardIndex, &bufferID); err != nil {
			continue
		}

		notify := PendingNotifyPayload{
			FileID:     fileID,
			ShardIndex: shardIndex,
			BufferID:   bufferID,
		}

		payloadBytes, _ := json.Marshal(notify)
		env := ProtocolEnvelope{
			Type:          "pending_notify",
			SchemaVersion: "1.0.0",
			MessageID:     uuid.NewString(),
			Timestamp:     time.Now().UTC().Format(time.RFC3339),
			Payload:       payloadBytes,
		}

		envBytes, _ := json.Marshal(env)
		select {
		case c.Send <- envBytes:
		default:
			log.Printf("[ws] warning: could not send pending_notify to node=%s", c.NodeID)
		}
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
	// 1. Fetch current buffer_id and version_number
	var bufferID *string
	var versionNumber int
	query := `
		SELECT buffer_id, version_number FROM file_locations
		WHERE file_id = $1 AND shard_index = $2 AND node_id = $3 AND status = 'RELAY_BUFFERED'
		ORDER BY version_number DESC
		LIMIT 1
	`
	err := pool.QueryRow(ctx, query, ack.FileID, ack.ShardIndex, c.NodeID).Scan(&bufferID, &versionNumber)
	if err != nil {
		return
	}

	// 2. Update status to NODE_STORED and clear buffer_id
	updateQuery := `
		UPDATE file_locations
		SET status = 'NODE_STORED', buffer_id = NULL, updated_at = NOW()
		WHERE file_id = $1 AND version_number = $2 AND shard_index = $3 AND node_id = $4
	`
	_, _ = pool.Exec(ctx, updateQuery, ack.FileID, versionNumber, ack.ShardIndex, c.NodeID)

	// 3. Delete physical buffer file
	if bufferID != nil && *bufferID != "" {
		_ = buf.Delete(*bufferID)
		if rClient != nil {
			_ = rClient.RemovePendingBuffer(ctx, c.NodeID, *bufferID)
		}
		log.Printf("[relay-buffer] shard verified and deleted from buffer: %s (file: %s shard: %d)",
			*bufferID, ack.FileID, ack.ShardIndex)
	}
}
