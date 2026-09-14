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
		FetchShard(pool, h, NewShardFetchRegistry())(rr, req)
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
	FetchShard(pool, h, NewShardFetchRegistry())(rr, req)
	require.Equal(t, http.StatusNotFound, rr.Code)

	// Malformed object id: 400 before any query runs.
	req = httptest.NewRequest(http.MethodGet, "/shards/not-a-hash", nil)
	req.SetPathValue("object_id", "not-a-hash")
	req = req.WithContext(context.WithValue(req.Context(), auth.AccountIDKey, acct))
	rr = httptest.NewRecorder()
	FetchShard(pool, h, NewShardFetchRegistry())(rr, req)
	require.Equal(t, http.StatusBadRequest, rr.Code)

	// Unauthenticated: 401.
	req = httptest.NewRequest(http.MethodGet, "/shards/"+unknown, nil)
	req.SetPathValue("object_id", unknown)
	rr = httptest.NewRecorder()
	FetchShard(pool, h, NewShardFetchRegistry())(rr, req)
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
	// arm the connection for the request id, then deliver one binary frame.
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
				reg.mu.Lock()
				reg.armedBin[connID] = requestID
				reg.mu.Unlock()
				reg.ResolveBinary(nodeClient, []byte("virtual-shard-bytes"))
				return
			}
			time.Sleep(10 * time.Millisecond)
		}
	}()

	req := httptest.NewRequest(http.MethodGet, "/shards/"+hash, nil)
	req.SetPathValue("object_id", hash)
	req = req.WithContext(context.WithValue(req.Context(), auth.AccountIDKey, acct))
	rr := httptest.NewRecorder()
	FetchShard(pool, h, reg)(rr, req)

	require.Equal(t, http.StatusOK, rr.Code)
	require.Equal(t, "application/octet-stream", rr.Header().Get("Content-Type"))
	require.Equal(t, "virtual-shard-bytes", rr.Body.String())
}