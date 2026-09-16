package handler

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/TalibMushtaq/nodus/services/relay/internal/config"
	"github.com/TalibMushtaq/nodus/services/relay/internal/db"
)

// TestFetchPeerNodesIntegration asserts the trust-anchor source: on successful
// node auth the Relay hands back the account's other ACTIVE nodes with their
// public keys, excluding the authenticating node itself and any non-ACTIVE row.
func TestFetchPeerNodesIntegration(t *testing.T) {
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set; skipping integration test")
	}

	ctx := context.Background()
	require.NoError(t, db.RunMigrations(url))
	pool, err := db.Open(ctx, &config.Config{DatabaseURL: url})
	require.NoError(t, err)
	t.Cleanup(pool.Close)

	u := fmt.Sprintf("%d", time.Now().UnixNano())
	account := "acct-peers-" + u
	other := "acct-peers-other-" + u
	for _, id := range []string{account, other} {
		_, err := pool.Exec(ctx,
			`INSERT INTO accounts (account_id, email, password_hash) VALUES ($1, $2, 'x')`,
			id, id+"@test.local")
		require.NoError(t, err)
	}

	seed := func(nodeID, accountID, status string) {
		_, err := pool.Exec(ctx,
			`INSERT INTO storage_nodes (node_id, account_id, public_key, status) VALUES ($1, $2, $3, $4)`,
			nodeID, accountID, "pk-"+nodeID, status)
		require.NoError(t, err)
	}
	seed("node-self-"+u, account, "ACTIVE")
	seed("node-peer-"+u, account, "ACTIVE")
	seed("node-revoked-"+u, account, "REVOKED")
	seed("node-foreign-"+u, other, "ACTIVE")

	peers := fetchPeerNodes(ctx, pool, account, "node-self-"+u)
	require.Len(t, peers, 1, "only the other ACTIVE node in the same account")
	require.Equal(t, "node-peer-"+u, peers[0].NodeID)
	require.Equal(t, "pk-node-peer-"+u, peers[0].PublicKey)
}
