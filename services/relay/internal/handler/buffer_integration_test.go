package handler

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/TalibMushtaq/nodus/services/relay/internal/auth"
	"github.com/TalibMushtaq/nodus/services/relay/internal/buffer"
	"github.com/TalibMushtaq/nodus/services/relay/internal/config"
	"github.com/TalibMushtaq/nodus/services/relay/internal/db"
	"github.com/TalibMushtaq/nodus/services/relay/internal/hub"
	"github.com/TalibMushtaq/nodus/services/relay/internal/rdb"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

// bufferHarness bundles the live resources the Phase 10 handler tests need.
// The upload and fetch handlers exercise the full Path C slicing against real
// Postgres (+ optional Redis for tokens).
type bufferHarness struct {
	ctx       context.Context
	pool      *db.Pool
	rClient   *rdb.Client
	buf       *buffer.Buffer
	hub       *hub.Hub
	accountID string
	nodeID    string
	fileID    string
}

func setupBufferHarness(t testing.TB) *bufferHarness {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set; skipping integration test")
	}

	ctx := context.Background()
	if err := db.RunMigrations(url); err != nil {
		t.Fatalf("run migrations: %v", err)
	}
	pool, err := db.Open(ctx, &config.Config{DatabaseURL: url})
	if err != nil {
		t.Fatalf("open pool: %v", err)
	}
	t.Cleanup(pool.Close)

	h := &bufferHarness{
		ctx:       ctx,
		pool:      pool,
		accountID: "acct-buffer",
		nodeID:    "node-buffer",
		fileID:    "file-buffer",
	}

	if redisURL := os.Getenv("TEST_REDIS_URL"); redisURL != "" {
		rClient, err := rdb.Open(ctx, &config.Config{RedisURL: redisURL})
		if err == nil {
			h.rClient = rClient
			t.Cleanup(func() { _ = rClient.Close() })
		}
	}

	dir := t.TempDir()
	b, err := buffer.New(dir)
	require.NoError(t, err)
	h.buf = b

	h.hub = hub.New(h.rClient)
	go h.hub.Run(ctx)

	// Seed the account, node, file and version the upload FK requirements need.
	// Each query carries its own args; the original blanket
	// `args := []any{h.accountID}` overwrite pushed (file_id, account_id) into
	// the accounts INSERT and would mask which tenant owns the seeded rows.
	seed := []struct {
		q    string
		args []any
	}{
		{
			q:    `INSERT INTO accounts (account_id, email, password_hash) VALUES ($1, 'buffer@test.local', 'x') ON CONFLICT DO NOTHING`,
			args: []any{h.accountID},
		},
		{
			q:    `INSERT INTO storage_nodes (node_id, account_id, public_key) VALUES ($1, $2, 'deadbeef') ON CONFLICT DO NOTHING`,
			args: []any{h.nodeID, h.accountID},
		},
		{
			q:    `INSERT INTO files (file_id, account_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
			args: []any{h.fileID, h.accountID},
		},
	}
	for _, s := range seed {
		_, err := pool.Exec(ctx, s.q, s.args...)
		require.NoError(t, err, "seed query failed: %s", s.q)
	}
	_, err = pool.Exec(ctx,
		`INSERT INTO file_versions (file_id, version_number, conflict_status, version_hash, shard_count, created_at)
		 VALUES ($1, $2, 'none', 'vhash', 1, NOW()) ON CONFLICT DO NOTHING`,
		h.fileID, 1)
	require.NoError(t, err)

	return h
}

func blake3Hex(data []byte) string {
	hasher := blake3Hasher()
	_, _ = hasher.Write(data)
	return hex.EncodeToString(hasher.Sum(nil))
}

// uploadShard drives the BufferUpload handler with the given metadata; an empty
// hash is computed from the body to keep call sites terse.
func (h *bufferHarness) uploadShard(t testing.TB, md uploadMetadata, body []byte, hashOverride string) *httptest.ResponseRecorder {
	t.Helper()
	hash := hashOverride
	if hash == "" {
		hash = blake3Hex(body)
	}

	req := httptest.NewRequest("POST", "/buffer/upload", bytes.NewReader(body))
	req = req.WithContext(context.WithValue(req.Context(), auth.AccountIDKey, h.accountID))
	req.Header.Set("X-Nodus-File-ID", md.FileID)
	req.Header.Set("X-Nodus-Version-Number", fmt.Sprintf("%d", md.VersionNumber))
	req.Header.Set("X-Nodus-Shard-Index", fmt.Sprintf("%d", md.ShardIndex))
	req.Header.Set("X-Nodus-Hash", hash)
	req.Header.Set("X-Nodus-Size", fmt.Sprintf("%d", md.Size))
	req.Header.Set("X-Nodus-Transfer-ID", md.TransferID)
	req.Header.Set("X-Nodus-Target-Node", md.TargetNode)
	req.Header.Set("X-Nodus-Source-Device", md.SourceDevice)

	rr := httptest.NewRecorder()
	BufferUpload(h.pool, h.rClient, h.buf, h.hub)(rr, req)
	return rr
}

// fetchShard drives the BufferFetch handler as the given node, which is what
// auth.RequireNodeAuth would have put in the context. Passing an empty asNode
// leaves the request with no node identity at all — that is how the
// "authenticated by nothing" case is expressed, not by omitting the argument.
func (h *bufferHarness) fetchShard(t testing.TB, token, asNode string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest("GET", "/buffer/fetch", nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if asNode != "" {
		req = req.WithContext(context.WithValue(req.Context(), auth.NodeIDKey, asNode))
	}
	rr := httptest.NewRecorder()
	BufferFetch(h.pool, h.rClient, h.buf)(rr, req)
	return rr
}

// shardStatus reads the file_locations status for a (file, version, shard, node).
func (h *bufferHarness) shardStatus(t testing.TB, fileID string, versionNumber, shardIndex int) string {
	t.Helper()
	var status string
	err := h.pool.QueryRow(h.ctx,
		`SELECT status FROM file_locations WHERE file_id=$1 AND version_number=$2 AND shard_index=$3 AND node_id=$4`,
		fileID, versionNumber, shardIndex, h.nodeID).Scan(&status)
	require.NoError(t, err)
	return status
}

func TestBufferUploadThenFetchE2E(t *testing.T) {
	h := setupBufferHarness(t)

	body := []byte("encrypted-shard-bytes")
	md := uploadMetadata{FileID: h.fileID, VersionNumber: 1, ShardIndex: 0, Size: int64(len(body)), TransferID: "t-1", TargetNode: h.nodeID, SourceDevice: "dev-1"}
	rr := h.uploadShard(t, md, body, "")
	require.Equal(t, 201, rr.Code)
	require.Equal(t, "RELAY_BUFFERED", h.shardStatus(t, h.fileID, 1, 0))

	// The upload response carries the buffer_id used for the fetch token.
	var resp struct {
		BufferID string `json:"buffer_id"`
	}
	require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &resp))
	require.NotEmpty(t, resp.BufferID)

	require.NotNil(t, h.rClient, "Redis required to mint fetch tokens for this test")
	token := "tok-e2e-" + uuid.NewString()
	require.NoError(t, h.rClient.SetFetchToken(h.ctx, token, h.nodeID, resp.BufferID, time.Minute))

	// Node fetches the shard bytes.
	fetchRR := h.fetchShard(t, token, h.nodeID)
	require.Equal(t, 200, fetchRR.Code)
	require.Equal(t, body, fetchRR.Body.Bytes())
	require.Equal(t, h.fileID, fetchRR.Header().Get("X-Nodus-File-ID"))
	require.Equal(t, "1", fetchRR.Header().Get("X-Nodus-Version-Number"))
	require.Equal(t, blake3Hex(body), fetchRR.Header().Get("X-Nodus-Hash"))
	require.Equal(t, "NODE_RECEIVING", h.shardStatus(t, h.fileID, 1, 0))

	// The token is single-use: replay must fail after the GETDEL consumed it.
	fetchRR2 := h.fetchShard(t, token, h.nodeID)
	require.Equal(t, 401, fetchRR2.Code)
}

// TestBufferFetchRejectsTokenInQueryString pins the credential's transport. A
// fetch token in the query string is a credential in every access log, proxy
// log and Referer header between the node and the Relay, and the Relay's own
// Caddy is one `log` directive away from writing it to disk. It is rejected
// rather than ignored so an un-upgraded node is told what to change.
func TestBufferFetchRejectsTokenInQueryString(t *testing.T) {
	h := setupBufferHarness(t)
	require.NotNil(t, h.rClient, "Redis required to mint fetch tokens for this test")

	token := "tok-query-" + uuid.NewString()
	bufferID := "buf-query-" + uuid.NewString()
	require.NoError(t, h.rClient.SetFetchToken(h.ctx, token, h.nodeID, bufferID, time.Minute))

	// A valid token in the query string is refused, and refused before it is
	// consumed: the token has to survive for the header path to work.
	req := httptest.NewRequest("GET", "/buffer/fetch?token="+token, nil)
	req = req.WithContext(context.WithValue(req.Context(), auth.NodeIDKey, h.nodeID))
	rr := httptest.NewRecorder()
	BufferFetch(h.pool, h.rClient, h.buf)(rr, req)
	require.Equal(t, 400, rr.Code)
	require.Contains(t, rr.Body.String(), "Authorization: Bearer")

	// The same token in the header still works, so the rejection really was
	// about the transport and did not burn the token.
	hdrRR := h.fetchShard(t, token, h.nodeID)
	require.NotEqual(t, 400, hdrRR.Code, "the query-param rejection consumed the token")
}

// TestBufferFetchRequiresABearerHeader covers the two ways a node can get the
// credential wrong: none at all, and a header without the Bearer scheme.
func TestBufferFetchRequiresABearerHeader(t *testing.T) {
	h := setupBufferHarness(t)
	require.NotNil(t, h.rClient, "Redis required to mint fetch tokens for this test")
	const tokenOnly = "tok-bare-abc123"

	for name, header := range map[string]string{
		"no header":      "",
		"missing scheme": tokenOnly,
		"empty bearer":   "Bearer ",
		"wrong scheme":   "Token " + tokenOnly,
	} {
		t.Run(name, func(t *testing.T) {
			req := httptest.NewRequest("GET", "/buffer/fetch", nil)
			if header != "" {
				req.Header.Set("Authorization", header)
			}
			// A correctly identified node, so a 401 can only be about the token.
			req = req.WithContext(context.WithValue(req.Context(), auth.NodeIDKey, h.nodeID))
			rr := httptest.NewRecorder()
			BufferFetch(h.pool, h.rClient, h.buf)(rr, req)
			require.Equal(t, 401, rr.Code, "body: %s", rr.Body.String())
		})
	}
}

// TestBufferFetchRefusesTokenIssuedToAnotherNode is the regression test for the
// audit's fetch-token finding. The token used to be a bare `buffer_id`, so it
// proved only that its holder knew a UUID; any node that obtained it could
// redeem a shard routed to somebody else and move it into NODE_RECEIVING. The
// token is now bound to the target node and checked against the identity
// RequireNodeAuth established.
func TestBufferFetchRefusesTokenIssuedToAnotherNode(t *testing.T) {
	h := setupBufferHarness(t)
	require.NotNil(t, h.rClient, "Redis required to mint fetch tokens for this test")

	body := []byte("encrypted-shard-bytes")
	md := uploadMetadata{FileID: h.fileID, VersionNumber: 1, ShardIndex: 0, Size: int64(len(body)), TransferID: "t-bind", TargetNode: h.nodeID, SourceDevice: "dev-1"}
	rr := h.uploadShard(t, md, body, "")
	require.Equal(t, 201, rr.Code)

	var resp struct {
		BufferID string `json:"buffer_id"`
	}
	require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &resp))
	require.NotEmpty(t, resp.BufferID)

	// A perfectly valid token, issued for the node that owns the shard.
	token := "tok-bound-" + uuid.NewString()
	require.NoError(t, h.rClient.SetFetchToken(h.ctx, token, h.nodeID, resp.BufferID, time.Minute))

	// Redeemed by a different, equally registered node. 403, not 401: the token
	// is real and unexpired, so reporting it as invalid would be a lie that
	// sends the operator looking for expiry or replay instead of a binding.
	other := h.fetchShard(t, token, "node-not-the-destination")
	require.Equal(t, 403, other.Code, "body: %s", other.Body.String())
	require.NotContains(t, other.Body.String(), "encrypted-shard-bytes",
		"another node's request must not return the shard's bytes")

	// Nothing moved: the shard is still waiting for its real destination, so
	// this is a refused fetch and not a corrupted one.
	require.Equal(t, "RELAY_BUFFERED", h.shardStatus(t, h.fileID, 1, 0),
		"a refused fetch must not transition the shard out of RELAY_BUFFERED")

	// The wrong node's attempt spent the token. That is deliberate — a token a
	// rejected node could keep retrying is a way to starve the shard's real
	// destination — and it is recoverable because the rightful node is re-notified
	// with a fresh token on its next reconnect. Pinned so the tradeoff is a
	// decision rather than an accident.
	require.Equal(t, 401, h.fetchShard(t, token, h.nodeID).Code,
		"a token burned by a wrong node must not still be redeemable by the right one")

	// And a fresh token for the rightful node works, so the burn is recoverable.
	fresh := "tok-fresh-" + uuid.NewString()
	require.NoError(t, h.rClient.SetFetchToken(h.ctx, fresh, h.nodeID, resp.BufferID, time.Minute))
	recovered := h.fetchShard(t, fresh, h.nodeID)
	require.Equal(t, 200, recovered.Code)
	require.Equal(t, body, recovered.Body.Bytes())
	require.Equal(t, "NODE_RECEIVING", h.shardStatus(t, h.fileID, 1, 0))
}

// TestBufferFetchRefusesRequestWithoutNodeIdentity covers the fail-closed case.
// The route is wrapped in RequireNodeAuth, so a real request always has an
// identity here; this asserts the handler is not relying on that wiring being
// correct. An unbound comparison would treat a missing identity as "" and the
// check would depend on the stored binding also being empty.
func TestBufferFetchRefusesRequestWithoutNodeIdentity(t *testing.T) {
	h := setupBufferHarness(t)
	require.NotNil(t, h.rClient, "Redis required to mint fetch tokens for this test")

	token := "tok-nobody-" + uuid.NewString()
	require.NoError(t, h.rClient.SetFetchToken(h.ctx, token, h.nodeID, "buf-nobody", time.Minute))

	rr := h.fetchShard(t, token, "")
	require.Equal(t, 403, rr.Code, "body: %s", rr.Body.String())
}

// TestBufferFetchRefusesUnboundLegacyToken covers a rolling deploy. A Relay from
// before the binding wrote a bare buffer_id; such a token carries no node, so
// there is nothing to verify it against and it must not be honoured as if it
// did. It is a 401 rather than a 500, because the node recovers from it by
// reconnecting and being re-notified, and a 500 reads as the Relay being down.
func TestBufferFetchRefusesUnboundLegacyToken(t *testing.T) {
	h := setupBufferHarness(t)
	require.NotNil(t, h.rClient, "Redis required to mint fetch tokens for this test")

	token := "tok-legacy-" + uuid.NewString()
	// Write the pre-binding value shape directly.
	require.NoError(t, h.rClient.Set(h.ctx, "fetch_token:"+token, "buf-legacy", time.Minute).Err())

	rr := h.fetchShard(t, token, h.nodeID)
	require.Equal(t, 401, rr.Code, "body: %s", rr.Body.String())
}

// TestIssueFetchTokenRefusesUnboundCall covers issuance. A caller that has lost
// track of which node a shard is for must get no token at all, rather than a
// working one that nobody can be prevented from redeeming.
func TestIssueFetchTokenRefusesUnboundCall(t *testing.T) {
	h := setupBufferHarness(t)
	require.NotNil(t, h.rClient, "Redis required to mint fetch tokens for this test")

	require.Empty(t, issueFetchToken(h.ctx, h.rClient, "", "buf-unbound"),
		"a token with no target node is exactly the token this change removes")
}

func TestBufferUploadRejectsUnknownVersion(t *testing.T) {
	h := setupBufferHarness(t)
	body := []byte("some-bytes")
	md := uploadMetadata{FileID: h.fileID, VersionNumber: 99, ShardIndex: 0, Size: int64(len(body)), TargetNode: h.nodeID}
	rr := h.uploadShard(t, md, body, "")
	require.Equal(t, 404, rr.Code)
}

func TestBufferUploadRejectsForeignNode(t *testing.T) {
	h := setupBufferHarness(t)
	body := []byte("some-bytes")
	md := uploadMetadata{FileID: h.fileID, VersionNumber: 1, ShardIndex: 0, Size: int64(len(body)), TargetNode: "node-from-another-account"}
	rr := h.uploadShard(t, md, body, "")
	require.Equal(t, 404, rr.Code)
}

// TestBufferUploadRejectsForeignVersion guards the tenant boundary: the upload
// handler must reject a (file_id, version_number) that exists in the catalogue
// but is owned by a different account. The version-existence check joins files
// for account scoping, so this must not fall through to the node check.
func TestBufferUploadRejectsForeignVersion(t *testing.T) {
	h := setupBufferHarness(t)

	foreignFile := "file-foreign-account"
	_, err := h.pool.Exec(h.ctx,
		`INSERT INTO accounts (account_id, email, password_hash) VALUES ('acct-other', 'other@test.local', 'x') ON CONFLICT DO NOTHING`)
	require.NoError(t, err)
	_, err = h.pool.Exec(h.ctx,
		`INSERT INTO files (file_id, account_id) VALUES ($1, 'acct-other') ON CONFLICT DO NOTHING`, foreignFile)
	require.NoError(t, err)
	_, err = h.pool.Exec(h.ctx,
		`INSERT INTO file_versions (file_id, version_number, conflict_status, version_hash, shard_count, created_at)
		 VALUES ($1, 3, 'none', 'vhash', 1, NOW()) ON CONFLICT DO NOTHING`, foreignFile)
	require.NoError(t, err)

	body := []byte("some-bytes")
	md := uploadMetadata{FileID: foreignFile, VersionNumber: 3, ShardIndex: 0, Size: int64(len(body)), TargetNode: h.nodeID}
	rr := h.uploadShard(t, md, body, "")
	require.Equal(t, 404, rr.Code)
	require.Equal(t, 0, func() int {
		var n int
		_ = h.pool.QueryRow(h.ctx,
			`SELECT COUNT(*) FROM file_locations WHERE file_id=$1 AND version_number=$2 AND shard_index=$3 AND node_id=$4`,
			foreignFile, 3, 0, h.nodeID).Scan(&n)
		return n
	}())
}

func TestBufferUploadRejectsBadHash(t *testing.T) {
	h := setupBufferHarness(t)
	body := []byte("some-bytes")
	md := uploadMetadata{FileID: h.fileID, VersionNumber: 1, ShardIndex: 0, Size: int64(len(body)), TargetNode: h.nodeID}
	rr := h.uploadShard(t, md, body, "deadbeef")
	require.Equal(t, 400, rr.Code)
	// Failure must not leave a location row behind.
	require.Equal(t, 0, func() int {
		var n int
		_ = h.pool.QueryRow(h.ctx,
			`SELECT COUNT(*) FROM file_locations WHERE file_id=$1 AND version_number=$2 AND shard_index=$3 AND node_id=$4`,
			h.fileID, 1, 0, h.nodeID).Scan(&n)
		return n
	}())
}

func TestBufferUploadProactivelyNotifiesOnlineNode(t *testing.T) {
	h := setupBufferHarness(t)
	if h.rClient == nil {
		t.Skip("TEST_REDIS_URL not set; skipping proactive-notify test")
	}

	// Register the target node with the hub so SendToNode has a destination.
	nodeClient := newTestingClient(h.accountID, h.nodeID)
	h.hub.Register(nodeClient)
	// Let the hub event loop process the registration.
	time.Sleep(50 * time.Millisecond)

	body := []byte("notify-me")
	md := uploadMetadata{FileID: h.fileID, VersionNumber: 1, ShardIndex: 2, Size: int64(len(body)), TransferID: "t-2", TargetNode: h.nodeID, SourceDevice: "dev-1"}
	rr := h.uploadShard(t, md, body, "")
	require.Equal(t, 201, rr.Code)

	select {
	case raw := <-nodeClient.Send:
		var env ProtocolEnvelope
		require.NoError(t, json.Unmarshal(raw, &env))
		require.Equal(t, "pending_notify", env.Type)

		var notify PendingNotifyPayload
		require.NoError(t, json.Unmarshal(env.Payload, &notify))
		require.Equal(t, h.fileID, notify.FileID)
		require.Equal(t, 1, notify.VersionNumber)
		require.Equal(t, 2, notify.ShardIndex)
		require.Equal(t, blake3Hex(body), notify.Hash)
		require.Equal(t, int64(len(body)), notify.Size)
		require.NotEmpty(t, notify.FetchToken)
	case <-time.After(2 * time.Second):
		t.Fatal("node never received pending_notify")
	}
}

// TestRegisterRerunsDeliveryAfterOfflineUpload is the offline counterpart to
// TestBufferUploadProactivelyNotifiesOnlineNode: when the target node is NOT
// connected at upload time, BufferUpload's SendToNode can't deliver, and the
// shard waits in RELAY_BUFFERED until the node reconnects and registers.
// register is the reconnect signal, so this guards the wiring that re-issues a
// fetch token and pushes pending_notify to the node's socket.
func TestRegisterRerunsDeliveryAfterOfflineUpload(t *testing.T) {
	h := setupBufferHarness(t)
	if h.rClient == nil {
		t.Skip("TEST_REDIS_URL not set; skipping reconnect-delivery test")
	}

	// Node is offline: do NOT register it with the hub, so the proactive
	// SendToNode path in BufferUpload has no destination to notify. A unique
	// file keeps this test independent from sibling tests, which share the
	// seeded file-buffer rows.
	fileID := "file-rereg-" + uuid.NewString()
	_, err := h.pool.Exec(h.ctx,
		`INSERT INTO files (file_id, account_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, fileID, h.accountID)
	require.NoError(t, err)
	_, err = h.pool.Exec(h.ctx,
		`INSERT INTO file_versions (file_id, version_number, conflict_status, version_hash, shard_count, created_at)
		 VALUES ($1, 1, 'none', 'vhash', 1, NOW()) ON CONFLICT DO NOTHING`, fileID)
	require.NoError(t, err)

	body := []byte("offline-upload-bytes")
	md := uploadMetadata{FileID: fileID, VersionNumber: 1, ShardIndex: 0, Size: int64(len(body)), TransferID: "t-offline", TargetNode: h.nodeID, SourceDevice: "dev-1"}
	rr := h.uploadShard(t, md, body, "")
	require.Equal(t, 201, rr.Code)
	require.Equal(t, "RELAY_BUFFERED", h.shardStatus(t, fileID, 1, 0))

	// The node comes back: authenticated session sends register. Storage nodes
	// omit account_id (pairing binds the account), so delivery must not depend
	// on an account-field match on the envelope.
	client := newTestingClient(h.accountID, h.nodeID)
	registerEnv := ProtocolEnvelope{
		Type:          "register",
		SchemaVersion: "1.0.0",
		MessageID:     uuid.NewString(),
		Timestamp:     time.Now().UTC().Format(time.RFC3339),
		Payload:       json.RawMessage(`{}`),
	}
	handleIncomingEnvelope(client, registerEnv, h.pool, h.rClient, h.buf, h.hub, nil, nil)

	// Sibling tests may have left other shards buffered for the same node, so
	// skip their notifies and wait for ours.
	var notify PendingNotifyPayload
	deadline := time.Now().Add(2 * time.Second)
found:
	for time.Now().Before(deadline) {
		select {
		case raw := <-client.Send:
			var env ProtocolEnvelope
			require.NoError(t, json.Unmarshal(raw, &env))
			if env.Type != "pending_notify" {
				continue
			}
			var candidate PendingNotifyPayload
			require.NoError(t, json.Unmarshal(env.Payload, &candidate))
			if candidate.FileID != fileID {
				continue
			}
			notify = candidate
			break found
		case <-time.After(100 * time.Millisecond):
		}
	}
	require.Equal(t, fileID, notify.FileID, "register did not re-deliver pending_notify for the buffered shard")
	require.Equal(t, 1, notify.VersionNumber)
	require.Equal(t, 0, notify.ShardIndex)
	require.Equal(t, blake3Hex(body), notify.Hash)
	require.NotEmpty(t, notify.FetchToken)

	// The re-issued token is redeemable: consuming it serves the bytes and
	// moves the shard out of RELAY_BUFFERED, completing the deferred delivery.
	// The token was minted by the real issuance path for the node that just
	// registered, so this also covers the binding end to end — nothing here
	// tells the fetch which node to accept.
	fetchRR := h.fetchShard(t, notify.FetchToken, client.NodeID)
	require.Equal(t, 200, fetchRR.Code)
	require.Equal(t, body, fetchRR.Body.Bytes())
	require.Equal(t, "NODE_RECEIVING", h.shardStatus(t, fileID, 1, 0))
}
