package handler

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/TalibMushtaq/nodus/services/relay/internal/auth"
	"github.com/TalibMushtaq/nodus/services/relay/internal/buffer"
	"github.com/TalibMushtaq/nodus/services/relay/internal/db"
	"github.com/TalibMushtaq/nodus/services/relay/internal/hub"
	"github.com/google/uuid"
)

// shardFetchTimeout is the *idle* budget for one node's shard fetch: it bounds
// the wait for the first chunk and the gap between chunks, not the total
// transfer. A large shard may legitimately stream for longer than this; only a
// node that stops making progress is dropped so the next holder can be tried.
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

// shardFetchChunk is one streamed unit of a shard fetch. The node sends zero or
// more data chunks after an "ok" result, then a done marker; an err chunk ends
// the stream before any bytes (the holder reported missing/error).
type shardFetchChunk struct {
	data []byte
	err  string
	done bool
}

type shardFetchWait struct {
	ch       chan shardFetchChunk
	fromNode string
}

// shardFrameVersion is the version byte of the binary shard stream frame.
const shardFrameVersion = 1

// shardFrameHeaderBytes is the fixed part of a frame: 1 version + 2 length.
const shardFrameHeaderBytes = 3

// decodeShardFrame parses `[u8 version][u16be id_len][request_id][payload]`.
// It returns ok=false for a malformed frame (wrong version, truncated header,
// or a length that overruns the buffer) so a corrupt frame is dropped rather
// than misrouted to a waiter.
func decodeShardFrame(frame []byte) (requestID string, payload []byte, ok bool) {
	if len(frame) < shardFrameHeaderBytes || frame[0] != shardFrameVersion {
		return "", nil, false
	}
	idLen := int(frame[1])<<8 | int(frame[2])
	start := shardFrameHeaderBytes
	end := start + idLen
	if idLen == 0 || end > len(frame) {
		return "", nil, false
	}
	return string(frame[start:end]), frame[end:], true
}

// ShardFetchRegistry correlates a relay→node shard fetch with the node's
// answer, bridging the HTTP request that issues it and the WS read loop that
// observes the result (mirrors PingTracker). Two extra duties beyond ping:
//
//   - each waiter records the node it was assigned to, so a result or binary
//     frame from a *different* node can never resolve it, and
//   - raw shard bytes travel as tagged binary frames (never JSON). Each frame
//     names its `request_id`, so a node can serve several fetches concurrently
//     over its single Relay socket and their chunks may interleave. This
//     replaces the earlier one-armed-request-per-connection scheme, under which
//     a second concurrent fetch overwrote the first and starved it until the
//     idle timeout.
type ShardFetchRegistry struct {
	mu      sync.Mutex
	waiters map[string]shardFetchWait
}

func NewShardFetchRegistry() *ShardFetchRegistry {
	return &ShardFetchRegistry{
		waiters: make(map[string]shardFetchWait),
	}
}

// register publishes a waiter for requestID assigned to fromNode. The returned
// cleanup must be called once the HTTP handler finishes (success, timeout, or
// client disconnect); it is idempotent with any resolve.
func (r *ShardFetchRegistry) register(requestID, fromNode string) (<-chan shardFetchChunk, func()) {
	// Buffered so a burst of chunks from a fast node does not hand backpressure
	// to the relay's WS read loop before the HTTP writer drains them.
	ch := make(chan shardFetchChunk, 32)
	r.mu.Lock()
	r.waiters[requestID] = shardFetchWait{ch: ch, fromNode: fromNode}
	r.mu.Unlock()
	return ch, func() {
		r.mu.Lock()
		delete(r.waiters, requestID)
		r.mu.Unlock()
	}
}

// HandleResult processes a node's shard_fetch_result. A non-ok status ends the
// waiter with an error so the HTTP handler can try the next holder; "ok" leaves
// the waiter registered to receive the tagged binary frames that follow.
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
		r.mu.Unlock()
		wait.ch <- shardFetchChunk{err: message, done: true}
		return
	}
	r.mu.Unlock()
}

// ResolveBinary forwards one tagged chunk of a shard stream to its waiter. The
// frame names its request_id, so chunks from several concurrent fetches on the
// same node connection can interleave safely. A malformed frame, an unknown
// request, or one assigned to a different node is dropped.
func (r *ShardFetchRegistry) ResolveBinary(c *hub.Client, frame []byte) {
	if r == nil || c == nil {
		return
	}
	requestID, payload, ok := decodeShardFrame(frame)
	if !ok || requestID == "" || c.NodeID == "" {
		return
	}
	r.mu.Lock()
	wait, found := r.waiters[requestID]
	if found && wait.fromNode != c.NodeID {
		found = false
	}
	r.mu.Unlock()
	if !found {
		return
	}
	// Copy: the WS read buffer may be reused once the callback returns.
	chunk := make([]byte, len(payload))
	copy(chunk, payload)
	wait.ch <- shardFetchChunk{data: chunk}
}

// HandleDone ends a shard-fetch stream. It deletes the waiter and signals that
// the last chunk has been delivered.
func (r *ShardFetchRegistry) HandleDone(c *hub.Client, env ProtocolEnvelope) {
	if r == nil || c == nil {
		return
	}
	var payload struct {
		RequestID string `json:"request_id"`
	}
	if err := json.Unmarshal(env.Payload, &payload); err != nil || payload.RequestID == "" {
		return
	}

	r.mu.Lock()
	wait, ok := r.waiters[payload.RequestID]
	if ok && wait.fromNode != c.NodeID {
		ok = false
	}
	if ok {
		delete(r.waiters, payload.RequestID)
	}
	r.mu.Unlock()
	if ok {
		wait.ch <- shardFetchChunk{done: true}
	}
}

// waitForShardChunk waits for the next streamed chunk, the caller's
// cancellation, or the idle timeout. A closed channel reports false.
func waitForShardChunk(
	ctx context.Context,
	ch <-chan shardFetchChunk,
	d time.Duration,
) (shardFetchChunk, bool) {
	select {
	case chunk, ok := <-ch:
		if !ok {
			return shardFetchChunk{}, false
		}
		return chunk, true
	case <-time.After(d):
		return shardFetchChunk{}, false
	case <-ctx.Done():
		return shardFetchChunk{}, false
	}
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

// FetchShard serves GET /shards/{object_id} — a session-authenticated download
// of a shard. It first tries the durable copy: every node that holds the object
// is asked, one at a time, over its live WS connection, and the first to start
// streaming wins (design A fallback for browser downloads). The shard is
// forwarded to the HTTP response chunk by chunk as the node sends it, so a
// multi-MiB shard is never buffered whole and the browser sees its first byte
// immediately. When no node has it yet, the Relay serves the shard straight
// from its own buffer, so a file that reached the Relay but has not been picked
// up by a node is still downloadable.
//
// Ownership is enforced on the relay side: only file_locations rows whose file
// belongs to the requesting account are considered, so a client can never use
// this endpoint to pull another tenant's shard bytes.
func FetchShard(pool *db.Pool, h *hub.Hub, shards *ShardFetchRegistry, buf *buffer.Buffer) http.HandlerFunc {
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
			// No node copy yet: serve the Relay's buffered ciphertext so an
			// upload that is only RELAY_BUFFERED is still downloadable. Scoped
			// to the account the same way as the node lookup above.
			if serveBufferedShard(w, r, pool, buf, accountID, objectID) {
				return
			}
			respondJSON(w, http.StatusNotFound, map[string]any{
				"error":   "shard_unavailable",
				"message": "this shard is not stored on any node or in the Relay buffer",
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

			// Wait for the first chunk. Until the first byte we can still send a
			// clean 404 and try the next holder; "ok" is followed by data chunks.
			first, ok := waitForShardChunk(r.Context(), ch, shardFetchTimeout)
			if !ok {
				cleanup()
				log.Printf("[shard-fetch] node %s did not answer for %s within %s", nodeID, objectID, shardFetchTimeout)
				continue
			}
			if first.err != "" {
				cleanup()
				log.Printf("[shard-fetch] node %s reported error for %s: %s", nodeID, objectID, first.err)
				continue
			}

			// Stream the shard to the browser as each chunk arrives. The server's
			// WriteTimeout (set for small requests) would truncate a large shard,
			// so clear it for this response, and flush per chunk so the client
			// sees progress instead of waiting for the whole transfer.
			rc := http.NewResponseController(w)
			if derr := rc.SetWriteDeadline(time.Time{}); derr != nil {
				log.Printf("[shard-fetch] could not clear write deadline for %s: %v", objectID, derr)
			}
			w.Header().Set("Content-Type", "application/octet-stream")
			w.WriteHeader(http.StatusOK)
			flusher, _ := w.(http.Flusher)

			writeChunk := func(data []byte) bool {
				if len(data) == 0 {
					return true
				}
				if _, werr := w.Write(data); werr != nil {
					log.Printf("[shard-fetch] write error for %s: %v", objectID, werr)
					return false
				}
				if flusher != nil {
					flusher.Flush()
				}
				return true
			}

			if !writeChunk(first.data) {
				cleanup()
				return
			}
			done := first.done
			for !done {
				next, ok := waitForShardChunk(r.Context(), ch, shardFetchTimeout)
				if !ok {
					log.Printf("[shard-fetch] stream for %s from %s stalled", objectID, nodeID)
					cleanup()
					return
				}
				if next.err != "" {
					log.Printf("[shard-fetch] node %s stream error for %s: %s", nodeID, objectID, next.err)
					cleanup()
					return
				}
				if !writeChunk(next.data) {
					cleanup()
					return
				}
				done = next.done
			}
			cleanup()
			return
		}

		respondJSON(w, http.StatusNotFound, map[string]any{
			"error":   "shard_unavailable",
			"message": "no online node served this shard",
		})
	}
}

// serveBufferedShard writes an account-owned shard from the Relay's own buffer,
// if one exists for this object. Returns true when it wrote a response (served
// bytes or a definite failure), false when there is no buffered copy so the
// caller can continue.
//
// `buffer_id` is set for RELAY_BUFFERED and in-flight (NODE_RECEIVING /
// NODE_VERIFIED) rows and cleared on NODE_STORED, so any non-null buffer_id is
// ciphertext the Relay still holds. Reading it does not change the row's state:
// the buffered copy now serves downloads *and* the node's later pickup.
func serveBufferedShard(
	w http.ResponseWriter,
	r *http.Request,
	pool *db.Pool,
	buf *buffer.Buffer,
	accountID, objectID string,
) bool {
	if buf == nil {
		return false
	}
	var bufferID *string
	err := pool.QueryRow(r.Context(), `
		SELECT fl.buffer_id
		FROM file_locations fl
		JOIN file_versions fv ON fv.file_id = fl.file_id AND fv.version_number = fl.version_number
		JOIN files f ON f.file_id = fv.file_id
		WHERE fl.hash = $1 AND fl.buffer_id IS NOT NULL AND f.account_id = $2
		ORDER BY fl.updated_at DESC
		LIMIT 1
	`, objectID, accountID).Scan(&bufferID)
	if errors.Is(err, pgx.ErrNoRows) {
		return false
	}
	if err != nil {
		log.Printf("[shard-fetch] buffer lookup failed for %s: %v", objectID, err)
		return false
	}
	if bufferID == nil || *bufferID == "" {
		return false
	}

	data, ferr := buf.Fetch(*bufferID)
	if ferr != nil {
		// The row outlived its buffer file (TTL sweep); report unavailable
		// rather than a 500.
		log.Printf("[shard-fetch] buffered shard %s missing (buffer=%s): %v", objectID, *bufferID, ferr)
		return false
	}

	// The buffered copy is already in memory, but still stream it in chunks and
	// flush so the client can start consuming before the whole shard is written.
	// Clear the server write deadline for the same reason as the node path.
	rc := http.NewResponseController(w)
	if derr := rc.SetWriteDeadline(time.Time{}); derr != nil {
		log.Printf("[shard-fetch] could not clear write deadline for buffered %s: %v", objectID, derr)
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	w.WriteHeader(http.StatusOK)
	flusher, _ := w.(http.Flusher)
	const bufferedChunk = 64 * 1024
	for off := 0; off < len(data); off += bufferedChunk {
		end := min(off+bufferedChunk, len(data))
		if _, werr := w.Write(data[off:end]); werr != nil {
			log.Printf("[shard-fetch] write error for buffered %s: %v", objectID, werr)
			return true
		}
		if flusher != nil {
			flusher.Flush()
		}
	}
	return true
}
