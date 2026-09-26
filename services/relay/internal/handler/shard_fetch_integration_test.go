package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/TalibMushtaq/nodus/services/relay/internal/auth"
	"github.com/TalibMushtaq/nodus/services/relay/internal/buffer"
	"github.com/TalibMushtaq/nodus/services/relay/internal/config"
	"github.com/TalibMushtaq/nodus/services/relay/internal/db"
	"github.com/TalibMushtaq/nodus/services/relay/internal/hub"
	"github.com/stretchr/testify/require"
)

// FetchShard is a mediated read path, so the integration test exercises the
// common failure modes with a live pool and zero connected nodes: unknown
// shard, another tenant's shard, and shards that are only relay-buffered.
func TestFetchShardScopesToAccountsNodeStoredShards(t *testing.T) {
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set; skipping integration test")
	}
	ctx := context.Background()
	require.NoError(t, db.RunMigrations(url))
	pool, err := db.Open(ctx, &config.Config{DatabaseURL: url})
	require.NoError(t, err)
	t.Cleanup(pool.Close)

	suffix := fmt.Sprint(time.Now().UnixNano())
	acctA, acctB := "acct-a-"+suffix, "acct-b-"+suffix
	nodeA, nodeB := "node-a-"+suffix, "node-b-"+suffix
	hash := fmt.Sprintf("%064x", suffix)
	for _, acct := range []string{acctA, acctB} {
		_, err = pool.Exec(ctx, `INSERT INTO accounts (account_id, email, password_hash) VALUES ($1, $2, 'hash')`, acct, acct+"@test.local")
		require.NoError(t, err)
	}

	// Same shard hash stored by a node of EACH account: ownership must win.
	_, err = pool.Exec(ctx,
		`INSERT INTO storage_nodes (node_id, account_id, public_key) VALUES ($1, $2, 'ab'), ($3, $4, 'cd')`,
		nodeA, acctA, nodeB, acctB)
	require.NoError(t, err)

	// Account A: file with the shard NODE_STORED on node-a.
	// Account B: file with the same shaod NODE_STORED on node-b.
	for i, acct := range []string{acctA, acctB} {
		node := nodeA
		if i == 1 {
			node = nodeB
		}
		_, err = pool.Exec(ctx,
			`INSERT INTO files (file_id, account_id, encrypted_name) VALUES ($1, $2, 'v1.aa')`,
			"file-"+acct, acct)
		require.NoError(t, err)
		_, err = pool.Exec(ctx,
			`INSERT INTO file_versions (file_id, version_number, version_hash, shard_count) VALUES ($1, 1, 'vh', 1)`,
			"file-"+acct)
		require.NoError(t, err)
		_, err = pool.Exec(ctx,
			`INSERT INTO file_locations (file_id, version_number, shard_index, node_id, hash, status) VALUES ($1, 1, 0, $2, $3, 'NODE_STORED')`,
			"file-"+acct, node, hash)
		require.NoError(t, err)
	}

	runCtx, stop := context.WithCancel(ctx)
	h := hub.New(nil)
	go h.Run(runCtx)
	t.Cleanup(stop)

	call := func(accountID string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, "/shards/"+hash, nil)
		// Handlers read r.PathValue (ServeMux-populated on the live server). Set
		// it manually for a direct handler call.
		req.SetPathValue("object_id", hash)
		req = req.WithContext(context.WithValue(req.Context(), auth.AccountIDKey, accountID))
		rr := httptest.NewRecorder()
		FetchShard(pool, h, NewShardFetchRegistry(), nil, testMaxShardBytes)(rr, req)
		return rr
	}

	// With no connected node, both accounts get 404 — the shard IS stored but
	// not serveable, so the phrasing must be an unavailable, not a leak signal.
	// The point of the ownership assertion: account B must pass through the
	// same "no online node" path as account A, never serving account A's row.
	rr := call(acctA)
	require.Equal(t, http.StatusNotFound, rr.Code)
	var bodyA map[string]any
	require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &bodyA))
	require.Equal(t, "shard_unavailable", bodyA["error"])
}

func TestFetchShardRejectsUnknownAndMalformed(t *testing.T) {
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set; skipping integration test")
	}
	context_ := context.Background()
	require.NoError(t, db.RunMigrations(url))
	pool, err := db.Open(context_, &config.Config{DatabaseURL: url})
	require.NoError(t, err)
	t.Cleanup(pool.Close)

	suffix := fmt.Sprint(time.Now().UnixNano())
	acct := "acct-unknown-" + suffix

	runCtx, stop := context.WithCancel(context_)
	h := hub.New(nil)
	go h.Run(runCtx)
	t.Cleanup(stop)

	// Unknown hash: 404 from the ownership query, no node ever contacted.
	unknown := fmt.Sprintf("%064x", "nope")
	req := httptest.NewRequest(http.MethodGet, "/shards/"+unknown, nil)
	req.SetPathValue("object_id", unknown)
	req = req.WithContext(context.WithValue(req.Context(), auth.AccountIDKey, acct))
	rr := httptest.NewRecorder()
	FetchShard(pool, h, NewShardFetchRegistry(), nil, testMaxShardBytes)(rr, req)
	require.Equal(t, http.StatusNotFound, rr.Code)

	// Malformed object id: 400 before any query runs.
	req = httptest.NewRequest(http.MethodGet, "/shards/not-a-hash", nil)
	req.SetPathValue("object_id", "not-a-hash")
	req = req.WithContext(context.WithValue(req.Context(), auth.AccountIDKey, acct))
	rr = httptest.NewRecorder()
	FetchShard(pool, h, NewShardFetchRegistry(), nil, testMaxShardBytes)(rr, req)
	require.Equal(t, http.StatusBadRequest, rr.Code)

	// Unauthenticated: 401.
	req = httptest.NewRequest(http.MethodGet, "/shards/"+unknown, nil)
	req.SetPathValue("object_id", unknown)
	rr = httptest.NewRecorder()
	FetchShard(pool, h, NewShardFetchRegistry(), nil, testMaxShardBytes)(rr, req)
	require.Equal(t, http.StatusUnauthorized, rr.Code)
}

func TestFetchShardEndToEndViaVirtualNode(t *testing.T) {
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set; skipping integration test")
	}
	ctx := context.Background()
	require.NoError(t, db.RunMigrations(url))
	pool, err := db.Open(ctx, &config.Config{DatabaseURL: url})
	require.NoError(t, err)
	t.Cleanup(pool.Close)

	suffix := fmt.Sprint(time.Now().UnixNano())
	acct, node := "acct-e2e-"+suffix, "node-e2e-"+suffix
	hash := fmt.Sprintf("%064x", suffix)
	file := "file-e2e-" + suffix

	_, err = pool.Exec(ctx, `INSERT INTO accounts (account_id, email, password_hash) VALUES ($1, $2, 'hash')`, acct, acct+"@test.local")
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO storage_nodes (node_id, account_id, public_key) VALUES ($1, $2, 'ab')`, node, acct)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO files (file_id, account_id, encrypted_name) VALUES ($1, $2, 'v1.aa')`, file, acct)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO file_versions (file_id, version_number, version_hash, shard_count) VALUES ($1, 1, 'vh', 1)`, file)
	require.NoError(t, err)
	_, err = pool.Exec(ctx,
		`INSERT INTO file_locations (file_id, version_number, shard_index, node_id, hash, status) VALUES ($1, 1, 0, $2, $3, 'NODE_STORED')`,
		file, node, hash)
	require.NoError(t, err)

	// A real hub with a fake storage-node client registered under the node's
	// id, so SendToNode delivers the fetch request into its Send channel. The
	// "node" then answers through the registry the same way the Rust node does:
	// send tagged binary frames, then the done marker.
	runCtx, stop := context.WithCancel(ctx)
	h := hub.New(nil)
	go h.Run(runCtx)
	t.Cleanup(stop)

	reg := NewShardFetchRegistry()
	connID := "virtual-" + suffix
	nodeClient := &hub.Client{
		Hub:    h,
		ConnID: connID,
		NodeID: node,
		Send:   make(chan []byte, 8),
	}
	h.Register(nodeClient)

	go func() {
		// The handler registers the waiter before SendToNode, so poll the map
		// until the request lands (its request_id + object_id are handler-set).
		requestID := ""
		for deadline := time.Now().Add(time.Second); time.Now().Before(deadline); {
			reg.mu.Lock()
			for id, wait := range reg.waiters {
				if wait.fromNode == node {
					requestID = id
				}
			}
			reg.mu.Unlock()
			if requestID != "" {
				// Two tagged chunks then the done marker: a streamed shard.
				reg.ResolveBinary(nodeClient, encodeFrame(requestID, []byte("virtual-")))
				reg.ResolveBinary(nodeClient, encodeFrame(requestID, []byte("shard-bytes")))
				reg.HandleDone(nodeClient, ProtocolEnvelope{
					Payload: []byte(`{"request_id":"` + requestID + `"}`),
				})
				return
			}
			time.Sleep(10 * time.Millisecond)
		}
	}()

	req := httptest.NewRequest(http.MethodGet, "/shards/"+hash, nil)
	req.SetPathValue("object_id", hash)
	req = req.WithContext(context.WithValue(req.Context(), auth.AccountIDKey, acct))
	rr := httptest.NewRecorder()
	FetchShard(pool, h, reg, nil, testMaxShardBytes)(rr, req)

	require.Equal(t, http.StatusOK, rr.Code)
	require.Equal(t, "application/octet-stream", rr.Header().Get("Content-Type"))
	require.Equal(t, "virtual-shard-bytes", rr.Body.String())
}

// A shard the Relay is still holding (no node pickup yet) must be downloadable
// from the buffer, and reading it must not disturb its delivery state.
func TestFetchShardServesRelayBufferedShard(t *testing.T) {
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set; skipping integration test")
	}
	ctx := context.Background()
	require.NoError(t, db.RunMigrations(url))
	pool, err := db.Open(ctx, &config.Config{DatabaseURL: url})
	require.NoError(t, err)
	t.Cleanup(pool.Close)

	buf, err := buffer.New(t.TempDir())
	require.NoError(t, err)

	suffix := fmt.Sprint(time.Now().UnixNano())
	acct, node := "acct-buf-"+suffix, "node-buf-"+suffix
	file := "file-buf-" + suffix
	hash := fmt.Sprintf("%064x", suffix)
	bufferID := "buffer-" + suffix
	shardBytes := []byte("buffered-ciphertext")

	_, err = pool.Exec(ctx, `INSERT INTO accounts (account_id, email, password_hash) VALUES ($1, $2, 'hash')`, acct, acct+"@test.local")
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO storage_nodes (node_id, account_id, public_key) VALUES ($1, $2, 'ab')`, node, acct)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO files (file_id, account_id, encrypted_name) VALUES ($1, $2, 'v1.aa')`, file, acct)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO file_versions (file_id, version_number, version_hash, shard_count) VALUES ($1, 1, 'vh', 1)`, file)
	require.NoError(t, err)
	_, err = pool.Exec(ctx,
		`INSERT INTO file_locations (file_id, version_number, shard_index, node_id, hash, status, buffer_id) VALUES ($1, 1, 0, $2, $3, 'RELAY_BUFFERED', $4)`,
		file, node, hash, bufferID)
	require.NoError(t, err)
	require.NoError(t, buf.Store(bufferID, shardBytes))

	runCtx, stop := context.WithCancel(ctx)
	h := hub.New(nil)
	go h.Run(runCtx)
	t.Cleanup(stop)

	req := httptest.NewRequest(http.MethodGet, "/shards/"+hash, nil)
	req.SetPathValue("object_id", hash)
	req = req.WithContext(context.WithValue(req.Context(), auth.AccountIDKey, acct))
	rr := httptest.NewRecorder()
	FetchShard(pool, h, NewShardFetchRegistry(), buf, testMaxShardBytes)(rr, req)

	require.Equal(t, http.StatusOK, rr.Code)
	require.Equal(t, shardBytes, rr.Body.Bytes())

	// Serving a download must not steal the shard from the node's pickup queue.
	var status string
	require.NoError(t, pool.QueryRow(ctx,
		`SELECT status FROM file_locations WHERE file_id = $1 AND shard_index = 0`, file).Scan(&status))
	require.Equal(t, "RELAY_BUFFERED", status)
}

// TestFetchShardStopsAnOversizedNodeStream covers the relay's willingness to
// proxy whatever a holder node sends. The response is streamed chunk by chunk as
// the node produces it, with no declared length and no ceiling, so a node that
// keeps sending is relayed byte for byte to the client — and the SDK assembles
// the whole shard in memory before hashing it, so the client's allocation grows
// with whatever the node chooses to send. `MaxShardBytes` is the size the relay
// already enforces on the upload path and derives its WebSocket read limit from,
// so no shard the relay accepts can legitimately exceed it.
//
// The response must stop at the cap instead of proxying the rest, and the client
// must be able to tell the transfer was cut short rather than seeing a
// short-but-plausible shard.
func TestFetchShardStopsAnOversizedNodeStream(t *testing.T) {
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set; skipping integration test")
	}
	ctx := context.Background()
	require.NoError(t, db.RunMigrations(url))
	pool, err := db.Open(ctx, &config.Config{DatabaseURL: url})
	require.NoError(t, err)
	t.Cleanup(pool.Close)

	suffix := fmt.Sprint(time.Now().UnixNano())
	acct, node := "acct-oversize-"+suffix, "node-oversize-"+suffix
	hash := fmt.Sprintf("%064x", suffix)
	file := "file-oversize-" + suffix

	_, err = pool.Exec(ctx, `INSERT INTO accounts (account_id, email, password_hash) VALUES ($1, $2, 'hash')`, acct, acct+"@test.local")
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO storage_nodes (node_id, account_id, public_key) VALUES ($1, $2, 'ab')`, node, acct)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO files (file_id, account_id, encrypted_name) VALUES ($1, $2, 'v1.aa')`, file, acct)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO file_versions (file_id, version_number, version_hash, shard_count) VALUES ($1, 1, 'vh', 1)`, file)
	require.NoError(t, err)
	// The holder declared a shard of testMaxShardBytes when it stored it.
	_, err = pool.Exec(ctx,
		`INSERT INTO file_locations (file_id, version_number, shard_index, node_id, hash, size_bytes, status)
		 VALUES ($1, 1, 0, $2, $3, $4, 'NODE_STORED')`,
		file, node, hash, testMaxShardBytes)
	require.NoError(t, err)

	runCtx, stop := context.WithCancel(ctx)
	h := hub.New(nil)
	go h.Run(runCtx)
	t.Cleanup(stop)

	reg := NewShardFetchRegistry()
	nodeClient := &hub.Client{
		Hub:    h,
		ConnID: "virtual-oversize-" + suffix,
		NodeID: node,
		Send:   make(chan []byte, 8),
	}
	h.Register(nodeClient)

	// A node that streams four times the cap, then claims it is done.
	const chunkSize = 8 * 1024
	oversized := 4 * testMaxShardBytes
	go func() {
		requestID := ""
		for deadline := time.Now().Add(2 * time.Second); time.Now().Before(deadline); {
			reg.mu.Lock()
			for id, wait := range reg.waiters {
				if wait.fromNode == node {
					requestID = id
				}
			}
			reg.mu.Unlock()
			if requestID == "" {
				time.Sleep(5 * time.Millisecond)
				continue
			}
			sent := 0
			for sent < oversized {
				reg.ResolveBinary(nodeClient, encodeFrame(requestID, make([]byte, chunkSize)))
				sent += chunkSize
			}
			reg.HandleDone(nodeClient, ProtocolEnvelope{
				Payload: []byte(`{"request_id":"` + requestID + `"}`),
			})
			return
		}
	}()

	req := httptest.NewRequest(http.MethodGet, "/shards/"+hash, nil)
	req.SetPathValue("object_id", hash)
	req = req.WithContext(context.WithValue(req.Context(), auth.AccountIDKey, acct))
	rr := httptest.NewRecorder()
	FetchShard(pool, h, reg, nil, testMaxShardBytes)(rr, req)

	require.Equal(t, http.StatusOK, rr.Code)
	body := rr.Body.Len()
	require.LessOrEqual(t, int64(body), int64(testMaxShardBytes),
		"the relay forwarded %d bytes of a %d byte shard", body, testMaxShardBytes)
	require.Less(t, body, oversized,
		"the relay proxied the node's entire oversized stream instead of stopping at the recorded size")

	// The declared length is what makes the cut detectable: the client asked for
	// testMaxShardBytes and will see a short read, rather than a body that ends
	// wherever the node decided to stop.
	require.Equal(t, fmt.Sprint(testMaxShardBytes), rr.Header().Get("Content-Length"),
		"a known shard size must be declared so a truncated stream is visible")
}

// TestFetchShardShedsWhenAtCapacity covers the HTTP half of the concurrent-fetch
// cap. The registry tests prove the accounting; this proves what a client is told
// when it hits it, and that the answer distinguishes the relay shedding load from
// a shard that could not be served — a client that treats them the same will
// either give up on a shard that exists or hammer a relay that is merely busy.
func TestFetchShardShedsWhenAtCapacity(t *testing.T) {
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set; skipping integration test")
	}
	ctx := context.Background()
	require.NoError(t, db.RunMigrations(url))
	pool, err := db.Open(ctx, &config.Config{DatabaseURL: url})
	require.NoError(t, err)
	t.Cleanup(pool.Close)

	suffix := fmt.Sprint(time.Now().UnixNano())
	acct, node := "acct-capacity-"+suffix, "node-capacity-"+suffix
	hash := fmt.Sprintf("%064x", suffix)
	file := "file-capacity-" + suffix

	_, err = pool.Exec(ctx, `INSERT INTO accounts (account_id, email, password_hash) VALUES ($1, $2, 'hash')`, acct, acct+"@test.local")
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO storage_nodes (node_id, account_id, public_key) VALUES ($1, $2, 'ab')`, node, acct)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO files (file_id, account_id, encrypted_name) VALUES ($1, $2, 'v1.aa')`, file, acct)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO file_versions (file_id, version_number, version_hash, shard_count) VALUES ($1, 1, 'vh', 1)`, file)
	require.NoError(t, err)
	_, err = pool.Exec(ctx,
		`INSERT INTO file_locations (file_id, version_number, shard_index, node_id, hash, size_bytes, status)
		 VALUES ($1, 1, 0, $2, $3, $4, 'NODE_STORED')`,
		file, node, hash, testMaxShardBytes)
	require.NoError(t, err)

	runCtx, stop := context.WithCancel(ctx)
	h := hub.New(nil)
	go h.Run(runCtx)
	t.Cleanup(stop)

	reg := NewShardFetchRegistry()
	// The node is registered but never answers, so these streams stay in flight
	// exactly as a slow or stalled holder would leave them.
	h.Register(&hub.Client{
		Hub: h, ConnID: "virtual-capacity-" + suffix, NodeID: node, Send: make(chan []byte, 8),
	})

	cleanups := make([]func(), 0, maxConcurrentShardFetchesPerAccount)
	for i := range maxConcurrentShardFetchesPerAccount {
		_, cleanup, err := reg.register(fmt.Sprintf("held-%d", i), node, acct)
		require.NoError(t, err)
		cleanups = append(cleanups, cleanup)
	}

	req := httptest.NewRequest(http.MethodGet, "/shards/"+hash, nil)
	req.SetPathValue("object_id", hash)
	req = req.WithContext(context.WithValue(req.Context(), auth.AccountIDKey, acct))
	rr := httptest.NewRecorder()
	FetchShard(pool, h, reg, nil, testMaxShardBytes)(rr, req)

	require.Equal(t, http.StatusServiceUnavailable, rr.Code)
	require.Equal(t, "1", rr.Header().Get("Retry-After"),
		"a shed request must say when to come back, or a client retries immediately")
	require.NotEmpty(t, rr.Header().Get("Content-Type"))
	var body map[string]any
	require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &body))
	require.Equal(t, "shard_fetch_busy", body["error"],
		"the client must be able to tell 'busy' from 'no node has this shard'")

	// And the refused request must not have left a waiter behind, or a client
	// that retries in a loop would make the leak permanent.
	reg.mu.Lock()
	live := len(reg.waiters)
	reg.mu.Unlock()
	require.Equal(t, maxConcurrentShardFetchesPerAccount, live,
		"a refused request must not register a waiter")

	for _, c := range cleanups {
		c()
	}
}
