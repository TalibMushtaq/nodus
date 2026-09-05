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

func setupBufferHarness(t *testing.T) *bufferHarness {
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
func (h *bufferHarness) uploadShard(t *testing.T, md uploadMetadata, body []byte, hashOverride string) *httptest.ResponseRecorder {
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

// shardStatus reads the file_locations status for a (file, version, shard, node).
func (h *bufferHarness) shardStatus(t *testing.T, fileID string, versionNumber, shardIndex int) string {
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
	require.NoError(t, h.rClient.SetFetchToken(h.ctx, token, resp.BufferID, time.Minute))

	// Node fetches the shard bytes.
	fetchReq := httptest.NewRequest("GET", "/buffer/fetch?token="+token, nil)
	fetchRR := httptest.NewRecorder()
	BufferFetch(h.pool, h.rClient, h.buf)(fetchRR, fetchReq)
	require.Equal(t, 200, fetchRR.Code)
	require.Equal(t, body, fetchRR.Body.Bytes())
	require.Equal(t, h.fileID, fetchRR.Header().Get("X-Nodus-File-ID"))
	require.Equal(t, "1", fetchRR.Header().Get("X-Nodus-Version-Number"))
	require.Equal(t, blake3Hex(body), fetchRR.Header().Get("X-Nodus-Hash"))
	require.Equal(t, "NODE_RECEIVING", h.shardStatus(t, h.fileID, 1, 0))

	// The token is single-use: replay must fail after the GETDEL consumed it.
	fetchReq2 := httptest.NewRequest("GET", "/buffer/fetch?token="+token, nil)
	fetchRR2 := httptest.NewRecorder()
	BufferFetch(h.pool, h.rClient, h.buf)(fetchRR2, fetchReq2)
	require.Equal(t, 401, fetchRR2.Code)
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
