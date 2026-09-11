package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/TalibMushtaq/nodus/services/relay/internal/auth"
	"github.com/TalibMushtaq/nodus/services/relay/internal/db"
)

// registerNode calls the authenticated /nodes/register handler for accountID.
func registerNode(t *testing.T, pool *db.Pool, accountID, nodeID, pubKey string) *httptest.ResponseRecorder {
	t.Helper()
	body, err := json.Marshal(RegisterNodeRequest{NodeID: nodeID, PublicKey: pubKey})
	require.NoError(t, err)
	req := httptest.NewRequest("POST", "/nodes/register", bytes.NewReader(body))
	req = req.WithContext(context.WithValue(req.Context(), auth.AccountIDKey, accountID))
	rr := httptest.NewRecorder()
	RegisterNode(pool)(rr, req)
	return rr
}

// /nodes/register must enforce the same node-key immutability invariant as
// /pairing/codes/redeem.
func TestRegisterNodeKeyMismatchRejected(t *testing.T) {
	pool, accountID := createPairingCodeHarness(t)
	nodeID := "reg-key-" + accountID
	key1 := "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899"
	key2 := "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff"

	require.Equal(t, http.StatusCreated, registerNode(t, pool, accountID, nodeID, key1).Code)

	rr := registerNode(t, pool, accountID, nodeID, key2)
	require.Equal(t, http.StatusConflict, rr.Code)
	var errResp struct {
		Error string `json:"error"`
	}
	require.NoError(t, json.NewDecoder(rr.Body).Decode(&errResp))
	require.Equal(t, "node_key_mismatch", errResp.Error)

	var storedKey string
	require.NoError(t, pool.QueryRow(context.Background(),
		`SELECT public_key FROM storage_nodes WHERE node_id = $1`, nodeID).Scan(&storedKey))
	require.Equal(t, key1, storedKey, "the registered key must never be replaced")
}

func TestRegisterNodeSameKeyIdempotentPreservesState(t *testing.T) {
	pool, accountID := createPairingCodeHarness(t)
	nodeID := "reg-idem-" + accountID
	key := "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899"

	require.Equal(t, http.StatusCreated, registerNode(t, pool, accountID, nodeID, key).Code)
	_, err := pool.Exec(context.Background(),
		`UPDATE storage_nodes SET status = 'REVOKED' WHERE node_id = $1`, nodeID)
	require.NoError(t, err)

	require.Equal(t, http.StatusCreated, registerNode(t, pool, accountID, nodeID, key).Code)

	var status string
	var isPrimary bool
	require.NoError(t, pool.QueryRow(context.Background(),
		`SELECT status, is_primary FROM storage_nodes WHERE node_id = $1`, nodeID).Scan(&status, &isPrimary))
	require.Equal(t, "REVOKED", status, "idempotent registration must not revive the node")
	require.True(t, isPrimary, "is_primary must be preserved")
}

func TestRegisterNodeOwnedElsewhere(t *testing.T) {
	pool, accountID := createPairingCodeHarness(t)

	_, err := pool.Exec(context.Background(),
		`INSERT INTO accounts (account_id, email, password_hash)
		 VALUES ('reg-other', 'reg-other@test.local', 'x') ON CONFLICT DO NOTHING`)
	require.NoError(t, err)
	_, err = pool.Exec(context.Background(),
		`INSERT INTO storage_nodes (node_id, account_id, public_key)
		 VALUES ('reg-owned', 'reg-other', 'deadbeef') ON CONFLICT DO NOTHING`)
	require.NoError(t, err)

	rr := registerNode(t, pool, accountID, "reg-owned", "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899")
	require.Equal(t, http.StatusConflict, rr.Code)
	var errResp struct {
		Error string `json:"error"`
	}
	require.NoError(t, json.NewDecoder(rr.Body).Decode(&errResp))
	require.Contains(t, []string{"node_id is registered to another account", "node_owned_elsewhere"}, errResp.Error)
}

func TestRegisterNodeFirstIsPrimarySecondNot(t *testing.T) {
	pool, accountID := createPairingCodeHarness(t)
	key := "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899"

	require.Equal(t, http.StatusCreated, registerNode(t, pool, accountID, "reg-first-"+accountID, key).Code)
	require.Equal(t, http.StatusCreated, registerNode(t, pool, accountID, "reg-second-"+accountID, key).Code)

	var primaries int
	require.NoError(t, pool.QueryRow(context.Background(),
		`SELECT count(*) FROM storage_nodes WHERE account_id = $1 AND is_primary`, accountID).Scan(&primaries))
	require.Equal(t, 1, primaries)
}
