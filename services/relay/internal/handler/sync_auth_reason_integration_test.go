package handler

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/TalibMushtaq/nodus/services/relay/internal/config"
	"github.com/TalibMushtaq/nodus/services/relay/internal/db"
	"github.com/TalibMushtaq/nodus/services/relay/internal/hub"
)

// runNodeAuth drives HandleNodeAuthResponse with an unauthenticated client
// whose nonce was issued in-memory (rClient nil -> memory fallback). The
// caller provides a signer so the tested node can prove knowledge of its key.
// Returns the single node_auth_result envelope the handler must send.
func runNodeAuth(t *testing.T, ctx context.Context, pool *db.Pool, h *hub.Hub, nodeID string, sign func(nonce []byte) string) (envType string, result NodeAuthResultPayload) {
	t.Helper()
	nonce := fmt.Sprintf("nodeauth-nonce-%d", time.Now().UnixNano())
	c := &hub.Client{
		Hub:             h,
		ConnID:          fmt.Sprintf("conn-nodeauth-%d", time.Now().UnixNano()),
		Send:            make(chan []byte, 1),
		AuthNonce:       nonce,
		AuthNonceExpiry: time.Now().Add(30 * time.Second),
	}

	respBytes, err := json.Marshal(NodeAuthResponsePayload{NodeID: nodeID, Signature: sign([]byte(nonce))})
	require.NoError(t, err)
	HandleNodeAuthResponse(ctx, c, ProtocolEnvelope{Type: "node_auth_response", Payload: respBytes}, pool, nil, h)

	select {
	case raw := <-c.Send:
		var env ProtocolEnvelope
		require.NoError(t, json.Unmarshal(raw, &env))
		require.NoError(t, json.Unmarshal(env.Payload, &result))
		return env.Type, result
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for node_auth_result")
		return "", NodeAuthResultPayload{}
	}
}

// setupNodeAuthHarness opens the integration DB and seeds an account. The
// caller decides whether a storage_nodes row exists (paired vs unpaired).
func setupNodeAuthHarness(t *testing.T) (context.Context, *db.Pool, *hub.Hub, string) {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set; skipping integration test")
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	require.NoError(t, db.RunMigrations(url))
	pool, err := db.Open(ctx, &config.Config{DatabaseURL: url})
	require.NoError(t, err)
	t.Cleanup(pool.Close)

	h := hub.New(nil)
	go h.Run(ctx)

	acctID := fmt.Sprintf("nodeauth-%d", time.Now().UnixNano())
	_, err = pool.Exec(ctx, `INSERT INTO accounts (account_id, email, password_hash) VALUES ($1, $2, 'x')`,
		acctID, acctID+"@test.local")
	require.NoError(t, err)
	return ctx, pool, h, acctID
}

func TestNodeAuthUnpairedNodeReason(t *testing.T) {
	ctx, pool, h, acctID := setupNodeAuthHarness(t)

	// No storage_nodes row -> the node is unknown, so it must get the
	// machine-readable "node_not_found" reason, not a bare message.
	nodeID := "node-" + acctID
	envType, result := runNodeAuth(t, ctx, pool, h, nodeID, func(nonce []byte) string { return "sig" })
	require.Equal(t, "node_auth_result", envType)
	require.Equal(t, "fail", result.Status)
	require.Equal(t, "node_not_found", result.Reason, "unpaired node must get a machine-readable reason")
	require.Contains(t, result.Message, "not found or inactive")
}

func TestNodeAuthPairedNodeSuccessNoReason(t *testing.T) {
	ctx, pool, h, acctID := setupNodeAuthHarness(t)

	// Pair: an ACTIVE storage node bound to the seeded account with a real
	// Ed25519 public key.
	nodeID := "node-" + acctID
	pubKey, privKey, err := ed25519.GenerateKey(rand.Reader)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO storage_nodes (node_id, account_id, public_key, status) VALUES ($1, $2, $3, 'ACTIVE')`,
		nodeID, acctID, hex.EncodeToString(pubKey))
	require.NoError(t, err)

	envType, result := runNodeAuth(t, ctx, pool, h, nodeID, func(nonce []byte) string {
		return hex.EncodeToString(ed25519.Sign(privKey, nonce))
	})
	require.Equal(t, "node_auth_result", envType)
	require.Equal(t, "ok", result.Status)
	require.Empty(t, result.Reason, "paired-node success must not carry a reason")
	require.Empty(t, result.Message)
}
