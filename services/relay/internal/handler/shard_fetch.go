package handler

import (
	"encoding/hex"
	"encoding/json"
	"log"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/TalibMushtaq/nodus/services/relay/internal/auth"
	"github.com/TalibMushtaq/nodus/services/relay/internal/db"
	"github.com/TalibMushtaq/nodus/services/relay/internal/hub"
	"github.com/google/uuid"
)

// shardFetchTimeout bounds how long the Relay waits for one node to answer a
// shard_fetch_request before giving up and trying the next holder (or failing
// the whole fetch). Shards are up to 8 MB; a slow disk read plus transport is
// covered comfortably while the browser's overall download stays responsive.
const shardFetchTimeout = 30 * time.Second

// shardFetchRequestPayload is the relay → node wire body: which stored object
// the Relay needs. The request is correlated by the envelope's MessageID (the
// node echoes it back as request_id), so the payload only needs the target.
type shardFetchRequestPayload struct {
	RequestID string `json:"request_id"`
	ObjectID  string `json:"object_id"`
}

// shardFetchResultPayload is the node → relay result. Status "ok" means the
// raw shard bytes follow in the next binary frame on the same connection;
// "missing"/"error" carry a reason and no bytes.
type shardFetchResultPayload struct {
	RequestID string `json:"request_id"`
	ObjectID  string `json:"object_id"`
	Status    string `json:"status"`
	Error     string `json:"error,omitempty"`
}

type shardFetchAnswer struct {
	bytes []byte
	err   string
}

type shardFetchWait struct {
	ch       chan shardFetchAnswer
	fromNode string
}

// ShardFetchRegistry correlates a relay→node shard fetch with the node's
// answer, bridging the HTTP request that issues it and the WS read loop that
// observes the result (mirrors PingTracker). Two extra duties beyond ping:
//
//   - each waiter records the node it was assigned to, so a result or binary
//     frame from a *different* node can never resolve it, and
//   - "ok" results arm the connection for the binary frame that immediately
//     follows, keeping the raw shard bytes out of JSON entirely.
type ShardFetchRegistry struct {
	mu       sync.Mutex
	waiters  map[string]shardFetchWait
	armedBin map[string]string // connID -> requestID awaiting its binary frame
}

func NewShardFetchRegistry() *ShardFetchRegistry {
	return &ShardFetchRegistry{
		waiters:  make(map[string]shardFetchWait),
		armedBin: make(map[string]string),
	}
}

// register publishes a waiter for requestID assigned to fromNode. The returned
// cleanup must be called once the HTTP handler finishes (success, timeout, or
// client disconnect); it is idempotent with any resolve.
func (r *ShardFetchRegistry) register(requestID, fromNode string) (<-chan shardFetchAnswer, func()) {
	ch := make(chan shardFetchAnswer, 1)
	r.mu.Lock()
	r.waiters[requestID] = shardFetchWait{ch: ch, fromNode: fromNode}
	r.mu.Unlock()
	return ch, func() {
		r.mu.Lock()
		delete(r.waiters, requestID)
		r.mu.Unlock()
	}
}

// HandleResult processes a node's shard_fetch_result. A non-ok status resolves
// the waiter with an error so the HTTP handler can try the next holder; "ok"
// just arms the connection for the binary frame that follows.
func (r *ShardFetchRegistry) HandleResult(c *hub.Client, env ProtocolEnvelope) {
	if r == nil || c == nil || c.NodeID == "" {
		return
	}
	var payload shardFetchResultPayload
	if err := json.Unmarshal(env.Payload, &payload); err != nil || payload.RequestID == "" {
		return
	}

	r.mu.Lock()
	wait, ok := r.waiters[payload.RequestID]
	if ok && wait.fromNode != c.NodeID {
		ok = false // a different node may not resolve this request
	}
	if ok && payload.Status != "ok" {
		message := payload.Error
		if message == "" {
			message = "node reported status " + payload.Status
		}
		delete(r.waiters, payload.RequestID)
		wait.ch <- shardFetchAnswer{err: message}
	}
	r.mu.Unlock()

	if ok && payload.Status == "ok" {
		r.mu.Lock()
		r.armedBin[c.ConnID] = payload.RequestID
		r.mu.Unlock()
	}
}

// ResolveBinary completes an armed shard fetch with the raw bytes carried by
// the binary frame that followed an "ok" result. Frames without an armed
// request are dropped.
func (r *ShardFetchRegistry) ResolveBinary(c *hub.Client, binary []byte) {
	if r == nil || c == nil {
		return
	}
	r.mu.Lock()
	requestID := r.armedBin[c.ConnID]
	delete(r.armedBin, c.ConnID)
	wait, ok := r.waiters[requestID]
	if ok && wait.fromNode != c.NodeID {
		ok = false
	}
	if ok {
		delete(r.waiters, requestID)
	}
	r.mu.Unlock()
	if !ok || requestID == "" {
		return
	}
	wait.ch <- shardFetchAnswer{bytes: binary}
}

// validShardObjectID matches the node's own object-id validation (layout.rs):
// exactly a 64-character lowercase hex BLAKE3 digest.
func validShardObjectID(id string) bool {
	if len(id) != 64 {
		return false
	}
	_, err := hex.DecodeString(id)
	return err == nil
}

// FetchShard serves GET /shards/{object_id} — a session-authenticated, relay-
// mediated download of a NODE_STORED shard (design A fallback for browser
// downloads when the browser has no trusted LAN host, or the direct fetch
// fails). The Relay asks every node that holds the object, one at a time, over
// their live WS connection, and streams back the first byte payload it gets.
//
// Ownership is enforced on the relay side: only file_locations rows whose file
// belongs to the requesting account are considered, so a client can never use
// this endpoint to pull another tenant's shard bytes.
func FetchShard(pool *db.Pool, h *hub.Hub, shards *ShardFetchRegistry) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		accountID, ok := auth.GetAccountID(r.Context())
		if !ok {
			respondError(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		if pool == nil || h == nil || shards == nil {
			respondError(w, http.StatusServiceUnavailable, "shard fetch unavailable")
			return
		}

		objectID := strings.TrimSpace(r.PathValue("object_id"))
		if !validShardObjectID(objectID) {
			respondError(w, http.StatusBadRequest, "invalid object id")
			return
		}

		rows, err := pool.Query(r.Context(), `
			SELECT DISTINCT fl.node_id
			FROM file_locations fl
			JOIN file_versions fv ON fv.file_id = fl.file_id AND fv.version_number = fl.version_number
			JOIN files f ON f.file_id = fv.file_id
			WHERE fl.hash = $1 AND fl.status = 'NODE_STORED' AND f.account_id = $2
		`, objectID, accountID)
		if err != nil {
			respondError(w, http.StatusInternalServerError, "failed to look up shard")
			return
		}
		defer rows.Close()

		var nodeIDs []string
		for rows.Next() {
			var nodeID string
			if err := rows.Scan(&nodeID); err == nil {
				nodeIDs = append(nodeIDs, nodeID)
			}
		}
		if len(nodeIDs) == 0 {
			respondJSON(w, http.StatusNotFound, map[string]any{
				"error":   "shard_unavailable",
				"message": "this shard is not stored on any node of this account",
			})
			return
		}

		for _, nodeID := range nodeIDs {
			requestID := uuid.NewString()
			ch, cleanup := shards.register(requestID, nodeID)

			payload, err := json.Marshal(shardFetchRequestPayload{
				RequestID: requestID,
				ObjectID:  objectID,
			})
			if err != nil {
				cleanup()
				continue
			}
			raw, err := json.Marshal(ProtocolEnvelope{
				Type:          "shard_fetch_request",
				SchemaVersion: "1.0.0",
				MessageID:     requestID,
				Timestamp:     time.Now().UTC().Format(time.RFC3339),
				Payload:       payload,
			})
			if err != nil || !h.SendToNode(nodeID, raw) {
				// Node offline or send buffer full: not eligible this pass.
				cleanup()
				continue
			}

			select {
			case answer := <-ch:
				cleanup()
				if answer.err != "" {
					log.Printf("[shard-fetch] node %s reported error for %s: %s", nodeID, objectID, answer.err)
					continue
				}
				w.Header().Set("Content-Type", "application/octet-stream")
				w.Header().Set("Content-Length", strconv.Itoa(len(answer.bytes)))
				w.WriteHeader(http.StatusOK)
				if _, werr := w.Write(answer.bytes); werr != nil {
					log.Printf("[shard-fetch] write error for %s: %v", objectID, werr)
				}
				return
			case <-time.After(shardFetchTimeout):
				cleanup()
				log.Printf("[shard-fetch] node %s did not answer for %s within %s", nodeID, objectID, shardFetchTimeout)
				continue
			case <-r.Context().Done():
				cleanup()
				return
			}
		}

		respondJSON(w, http.StatusNotFound, map[string]any{
			"error":   "shard_unavailable",
			"message": "no online node served this shard",
		})
	}
}
