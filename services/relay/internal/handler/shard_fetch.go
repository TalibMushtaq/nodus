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

	"github.com/TalibMushtaq/nodus/services/relay/internal/auth"
	"github.com/TalibMushtaq/nodus/services/relay/internal/buffer"
	"github.com/TalibMushtaq/nodus/services/relay/internal/config"
	"github.com/TalibMushtaq/nodus/services/relay/internal/db"
	"github.com/TalibMushtaq/nodus/services/relay/internal/hub"
	"github.com/google/uuid"
)

// shardFetchTimeout is the *idle* budget for one node's shard fetch: it bounds
// the wait for the first chunk and the gap between chunks, not the total
// transfer. A large shard may legitimately stream for longer than this; only a
// node that stops making progress is dropped so the next holder can be tried.
const shardFetchTimeout = 30 * time.Second

// Concurrent stream caps.
//
// Each in-flight fetch holds a buffered chunk queue of node-sized chunks — the
// node streams 256 KiB at a time into a 32-slot queue, so up to ~8 MiB — plus
// the HTTP response it is writing. Left uncapped, one session with a valid
// account can open as many downloads as it likes and the relay buffers every one
// of them, which is a way to spend the relay's memory on demand.
//
// The per-account cap is the fairness bound, and sits below the node's own
// MAX_CONCURRENT_SHARD_SERVES (8) so a single account cannot saturate one node's
// serve budget either. The global cap is the resource bound, for when many
// accounts do it at once.
const (
	maxConcurrentShardFetchesPerAccount = 4
	maxConcurrentShardFetches           = 16
)

// ErrShardFetchAtCapacity is returned by register when the caps are reached.
var ErrShardFetchAtCapacity = errors.New("too many concurrent shard fetches")

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

// shardFetchWait is one in-flight fetch. It carries two signals the sender side
// needs and the map alone cannot give it:
//
//   - abort, so a consumer that is being sent to can be told *why* without
//     queueing behind the chunks it is already behind, and
//   - stopped, closed by the HTTP handler's cleanup, so a waiter that nobody is
//     reading any more is recognisable.
//
// Every method here is called from the node's WebSocket read loop, so none of
// them may block. A blocked send is a stalled connection.
type shardFetchWait struct {
	ch       chan shardFetchChunk
	fromNode string
	// abort is buffered so failing a fetch never waits on the consumer.
	abort chan error
	// stopped is closed exactly once, by the cleanup the handler runs when it
	// finishes with the fetch.
	stopped  chan struct{}
	stopOnce sync.Once
}

// deliver hands one chunk to the consumer. It never blocks: a full channel means
// the consumer is not keeping up, and the fetch is failed instead, because the
// alternative is stalling every other message on this node's connection.
func (w *shardFetchWait) deliver(chunk shardFetchChunk) {
	select {
	case w.ch <- chunk:
		return
	case <-w.stopped:
		return
	default:
	}
	w.fail(errors.New("shard stream outran the relay: the consumer could not keep up"))
}

// fail reports a fetch as over, with a reason the handler can log or show. It is
// safe to call more than once; the first reason wins.
func (w *shardFetchWait) fail(err error) {
	if err == nil {
		err = errors.New("shard fetch failed")
	}
	select {
	case <-w.stopped:
		return
	default:
	}
	select {
	case w.abort <- err:
	default: // a reason is already queued
	}
}

// stop releases anything still waiting on this fetch. The handler runs it on
// every exit path — success, timeout, client disconnect — so a fetch that was
// abandoned mid-stream cannot leave a sender behind.
func (w *shardFetchWait) stop() {
	w.stopOnce.Do(func() { close(w.stopped) })
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
	waiters map[string]*shardFetchWait
	// inFlight and perAccount track registered waiters against the caps above.
	// They are counts of registrations, not of bytes, which is the part that can
	// be known before the first chunk arrives.
	inFlight   int
	perAccount map[string]int
}

func NewShardFetchRegistry() *ShardFetchRegistry {
	return &ShardFetchRegistry{
		waiters:    make(map[string]*shardFetchWait),
		perAccount: make(map[string]int),
	}
}

// register publishes a waiter for requestID assigned to fromNode on behalf of
// accountID, and returns ErrShardFetchAtCapacity if the concurrent-fetch caps are
// already reached — the caller must not send anything to the node in that case.
//
// The returned cleanup must be called once the HTTP handler finishes (success,
// timeout, or client disconnect). It is idempotent, so calling it after a resolve
// has already removed the waiter is safe, and that matters because it is what
// returns the capacity.
func (r *ShardFetchRegistry) register(
	requestID, fromNode, accountID string,
) (*shardFetchWait, func(), error) {
	// Buffered so a burst of chunks from a fast node does not hand backpressure
	// to the relay's WS read loop before the HTTP writer drains them.
	ch := make(chan shardFetchChunk, 32)
	wait := &shardFetchWait{
		ch:       ch,
		fromNode: fromNode,
		abort:    make(chan error, 1),
		stopped:  make(chan struct{}),
	}
	r.mu.Lock()
	if r.inFlight >= maxConcurrentShardFetches ||
		r.perAccount[accountID] >= maxConcurrentShardFetchesPerAccount {
		r.mu.Unlock()
		return nil, nil, ErrShardFetchAtCapacity
	}
	r.waiters[requestID] = wait
	r.inFlight++
	r.perAccount[accountID]++
	r.mu.Unlock()

	// One Once for the whole release. Cleanup is called on several exit paths and
	// may race a resolve that already removed the waiter; decrementing twice
	// would leak capacity permanently, which is the kind of drift that shows up
	// as a relay that slowly stops serving downloads.
	var releaseOnce sync.Once
	return wait, func() {
		releaseOnce.Do(func() {
			r.mu.Lock()
			delete(r.waiters, requestID)
			if r.inFlight > 0 {
				r.inFlight--
			}
			if r.perAccount[accountID] > 1 {
				r.perAccount[accountID]--
			} else {
				delete(r.perAccount, accountID)
			}
			r.mu.Unlock()
			// Stop after unpublishing, so a sender that already resolved this
			// waiter is released even if it has not reached its send yet.
			wait.stop()
		})
	}, nil
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
		wait.fail(errors.New(message))
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
	wait.deliver(shardFetchChunk{data: chunk})
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
		wait.deliver(shardFetchChunk{done: true})
	}
}

// waitForShardChunk waits for the next streamed chunk, the caller's
// cancellation, or the idle timeout. A closed channel reports false.
func waitForShardChunk(
	ctx context.Context,
	wait *shardFetchWait,
	d time.Duration,
) (shardFetchChunk, bool) {
	// A failed fetch stops immediately rather than writing more of a stream that
	// is already known to be broken, so the abort is checked before the queue.
	select {
	case err := <-wait.abort:
		return shardFetchChunk{err: err.Error(), done: true}, true
	default:
	}
	select {
	case chunk, ok := <-wait.ch:
		if !ok {
			return shardFetchChunk{}, false
		}
		return chunk, true
	case err := <-wait.abort:
		// Reported as an ordinary error chunk so the handler's existing
		// "this node could not serve it, try the next one" path is unchanged.
		return shardFetchChunk{err: err.Error(), done: true}, true
	case <-time.After(d):
		return shardFetchChunk{}, false
	case <-ctx.Done():
		return shardFetchChunk{}, false
	}
}

// shardStreamOverheadBytes is the slack allowed on top of MaxShardBytes for
// per-shard encryption framing. It matches the headroom main.go adds to the
// WebSocket read limit for the same reason.
const shardStreamOverheadBytes = 1 << 20

// shardStreamCeiling is the most the relay will forward for one shard.
//
// The declared size is what the holder reported when it stored the shard
// (file_locations.size_bytes), so it is the tightest bound available and lets the
// response carry a Content-Length. It is not trusted on its own: a node that
// declares a huge shard must not thereby raise its own limit, so the configured
// MaxShardBytes — already enforced on the upload path and the source of the
// WebSocket read limit — is the hard ceiling. A missing or absent size (rows
// written before the column existed) falls back to that ceiling alone.
func shardStreamCeiling(declared, maxShardBytes int64) int64 {
	if maxShardBytes <= 0 {
		// A Config built without Load has no shard size. Fall back to the same
		// default config.Load would have applied rather than collapsing the
		// ceiling to the framing overhead, which would refuse every shard over
		// 1 MiB for no reason the operator could see.
		maxShardBytes = config.DefaultMaxShardBytes
	}
	hard := maxShardBytes + shardStreamOverheadBytes
	if declared > 0 && declared < hard {
		return declared
	}
	return hard
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
func FetchShard(
	pool *db.Pool,
	h *hub.Hub,
	shards *ShardFetchRegistry,
	buf *buffer.Buffer,
	maxShardBytes int64,
) http.HandlerFunc {
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
			SELECT DISTINCT fl.node_id, fl.size_bytes
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
		// Holders may disagree about the size; the smallest claim is the one that
		// can bound the response, so a node cannot raise the limit by storing
		// under a second, larger location row.
		var declaredSize int64 = -1
		for rows.Next() {
			var (
				nodeID    string
				sizeBytes *int64
			)
			if err := rows.Scan(&nodeID, &sizeBytes); err != nil {
				continue
			}
			nodeIDs = append(nodeIDs, nodeID)
			if sizeBytes != nil && *sizeBytes > 0 &&
				(declaredSize < 0 || *sizeBytes < declaredSize) {
				declaredSize = *sizeBytes
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
			wait, cleanup, err := shards.register(requestID, nodeID, accountID)
			if err != nil {
				// At capacity. Answering now rather than walking the remaining
				// holders is deliberate: the caps are not per node, so every
				// further attempt would fail the same way, and each one would
				// cost a node round trip plus another idle-timeout wait.
				//
				// 503 rather than 429: this is the relay shedding load, not the
				// client misbehaving, and Retry-After is the hint a client needs
				// to space out its downloads instead of retrying immediately.
				log.Printf("[shard-fetch] refusing %s for account %s: %v", objectID, accountID, err)
				w.Header().Set("Retry-After", "1")
				respondJSON(w, http.StatusServiceUnavailable, map[string]any{
					"error":   "shard_fetch_busy",
					"message": "too many downloads in progress; retry shortly",
				})
				return
			}

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
			first, ok := waitForShardChunk(r.Context(), wait, shardFetchTimeout)
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
			//
			// The response is bounded by the ceiling above. Without it the relay
			// proxies whatever the holder sends, and the SDK assembles the whole
			// shard in memory before hashing it, so a node choosing its own
			// length chooses the client's allocation. When the size is known the
			// Content-Length is declared, so a client sees a short read for what
			// it is rather than a body that ends when the node stops talking.
			ceiling := shardStreamCeiling(declaredSize, maxShardBytes)
			rc := http.NewResponseController(w)
			if derr := rc.SetWriteDeadline(time.Time{}); derr != nil {
				log.Printf("[shard-fetch] could not clear write deadline for %s: %v", objectID, derr)
			}
			w.Header().Set("Content-Type", "application/octet-stream")
			if declaredSize > 0 && declaredSize <= ceiling {
				w.Header().Set("Content-Length", strconv.FormatInt(declaredSize, 10))
			}
			w.WriteHeader(http.StatusOK)
			flusher, _ := w.(http.Flusher)

			var forwarded int64
			// oversized records that a node tried to make the response larger than
			// the recorded shard, so the log distinguishes a lying holder from a
			// transfer that merely failed.
			oversized := false

			writeChunk := func(data []byte) bool {
				if len(data) == 0 {
					return true
				}
				if int64(len(data)) > ceiling-forwarded {
					oversized = true
					return false
				}
				if _, werr := w.Write(data); werr != nil {
					log.Printf("[shard-fetch] write error for %s: %v", objectID, werr)
					return false
				}
				forwarded += int64(len(data))
				if flusher != nil {
					flusher.Flush()
				}
				return true
			}

			if !writeChunk(first.data) {
				cleanup()
				if oversized {
					log.Printf("[shard-fetch] node %s sent more than the %d byte limit for %s; "+
						"the download was cut short", nodeID, ceiling, objectID)
				}
				return
			}
			done := first.done
			for !done {
				next, ok := waitForShardChunk(r.Context(), wait, shardFetchTimeout)
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
					if oversized {
						log.Printf("[shard-fetch] node %s sent more than the %d byte limit for %s; "+
							"the download was cut short", nodeID, ceiling, objectID)
					}
					return
				}
				done = next.done
			}
			cleanup()
			if forwarded != declaredSize && declaredSize > 0 {
				// The declared length was not met, so the client will see a short
				// read. Say so here, because otherwise this is indistinguishable
				// from a node that simply ended the stream early.
				log.Printf("[shard-fetch] node %s sent %d bytes of the %d it declared for %s",
					nodeID, forwarded, declaredSize, objectID)
			}
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
	if errors.Is(err, db.ErrNotFound) {
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
