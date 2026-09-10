package handler

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"net/url"
	"time"

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
	CheckOrigin:     func(r *http.Request) bool { return true }, // checked per Relay config below
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

func nodeOnlyMessageTypes(messageType string) bool {
	switch messageType {
	case "sync_hello", "event_batch", "snapshot_begin", "snapshot_chunk", "snapshot_end", "shard_ack":
		return true
	default:
		return false
	}
}

// presencePeerID returns only the identity authenticated for this connection.
// Heartbeat payloads deliberately do not participate in this decision.
func presencePeerID(c *hub.Client) string {
	if c.NodeID != "" {
		return c.NodeID
	}
	return c.DeviceID
}

// WebSocket handles incoming WebSocket connection upgrades and message lifecycle.
func WebSocket(h *hub.Hub, pool *db.Pool, rClient *rdb.Client, buf *buffer.Buffer, store auth.SessionStore, cfg *config.Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !originAllowed(r, cfg) {
			http.Error(w, "forbidden origin", http.StatusForbidden)
			return
		}
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

		// Browser WebSocket handshakes authenticate via the session cookie
		// (?token= JWT removed in Phase 7a §1). Storage Nodes authenticate
		// separately through the Ed25519 challenge-response below, so a missing
		// cookie here only leaves the client's AccountID/DeviceID unset.
		if cookie, err := r.Cookie(cfg.SessionCookieName); store != nil && err == nil && cookie.Value != "" {
			if sess, err := store.LookupSession(r.Context(), cookie.Value); err == nil {
				client.AccountID = sess.AccountID
				client.DeviceID = sess.DeviceID
				client.IsAuthenticated = true
			}
		}

		// Phase 14a: a browser (the client sends an Origin header; native
		// storage nodes deliberately do not) that ended up unauthenticated —
		// no session cookie, or a cookie that failed the session lookup — is
		// rejected immediately with a custom close code instead of being left
		// half-open. This lets the web client distinguish auth rejection from
		// a transient network error and skip the reconnect backoff loop.
		// Storage nodes stay open to complete the challenge-response below.
		if r.Header.Get("Origin") != "" && !client.IsAuthenticated {
			_ = conn.WriteMessage(websocket.CloseMessage,
				websocket.FormatCloseMessage(hub.CloseCodeUnauthorized, "unauthorized"))
			h.Unregister(client)
			_ = conn.Close()
			return
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

			// Phase 14a audit (V4): bound how fast a single connection's
			// messages are processed (Redis SETs, DB writes, forwarding). Floods
			// are dropped, not disconnected — the socket stays usable.
			if !c.RateLimitAllowed(time.Now()) {
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
	if !c.IsAuthenticated && env.Type != "node_auth_response" {
		return
	}

	// Phase 14a audit (V5): the sync/snapshot/shard_ack surfaces belong to the
	// storage-node protocol. A browser connection authenticated by session
	// cookie must never reach them, even though the payload handlers re-check
	// identity. Defense in depth: browsers can only heartbeat, register, and
	// do WebRTC signaling.
	if nodeOnlyMessageTypes(env.Type) && c.NodeID == "" {
		log.Printf("[ws] rejected node-only message type %q from conn=%s", env.Type, c.ConnID)
		return
	}

	switch env.Type {
	case "webrtc_offer", "webrtc_answer", "webrtc_ice_candidate":
		HandleWebRTCSignaling(ctx, c, env, h)

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

		if !c.IsAuthenticated || c.AccountID == "" || c.AccountID != reg.AccountID {
			log.Printf("[ws] account ID mismatch for conn=%s", c.ConnID)
			return
		}
		// Browser identity is derived from the session; never accept peer-supplied
		// node/device IDs or account IDs.
		log.Printf("[ws] ignoring client register identity fields for conn=%s", c.ConnID)

	case "heartbeat":
		var hb HeartbeatPayload
		if err := json.Unmarshal(env.Payload, &hb); err != nil {
			return
		}

		// Phase 14a audit (V2): presence is keyed off the authenticated session
		// identity, never the client-supplied heartbeat id — otherwise any
		// authenticated client could mark arbitrary peers (e.g. a dead storage
		// node) as online. The DB write is throttled to once a minute per conn.
		if peerID := presencePeerID(c); peerID != "" {
			h.RefreshPresence(ctx, peerID)
		}
		if c.NodeID != "" {
			if pool != nil && time.Since(c.LastSeenAtSync) > time.Minute {
				_, _ = pool.Exec(ctx, "UPDATE storage_nodes SET last_seen_at = NOW() WHERE node_id = $1", c.NodeID)
				c.LastSeenAtSync = time.Now()
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

func originAllowed(r *http.Request, cfg *config.Config) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	} // native nodes do not send browser Origin
	u, err := url.Parse(origin)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return false
	}
	for _, allowed := range cfg.AllowedOrigins {
		if origin == allowed {
			return true
		}
	}
	return false
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
