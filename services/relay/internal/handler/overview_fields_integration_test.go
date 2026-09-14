package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/TalibMushtaq/nodus/services/relay/internal/auth"
)

// The Overview reads capacity from GET /nodes and presence from GET /devices;
// these integration tests pin the new fields onto those responses so the Relay
// and web client cannot drift.

func TestListNodesReportsCapacity(t *testing.T) {
	pool, accountID := createPairingCodeHarness(t)
	nodeID := "cap-" + accountID
	require.Equal(t, http.StatusCreated, registerNode(t, pool, accountID, nodeID, "pk").Code)

	// Simulate the heartbeat write the WS handler performs.
	_, err := pool.Exec(context.Background(),
		"UPDATE storage_nodes SET used_bytes = $1, total_bytes = $2 WHERE node_id = $3",
		int64(123), int64(456), nodeID)
	require.NoError(t, err)

	req := httptest.NewRequest("GET", "/nodes", nil)
	req = req.WithContext(context.WithValue(req.Context(), auth.AccountIDKey, accountID))
	rr := httptest.NewRecorder()
	ListNodes(pool)(rr, req)
	require.Equal(t, http.StatusOK, rr.Code)

	var nodes []NodeResponse
	require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &nodes))
	require.Len(t, nodes, 1)
	require.Equal(t, int64(123), nodes[0].UsedBytes)
	require.Equal(t, int64(456), nodes[0].TotalBytes)
}

func TestRegisterAndListDevicesReportsPresence(t *testing.T) {
	pool, accountID := createPairingCodeHarness(t)
	deviceID := "presence-" + accountID

	body, err := json.Marshal(RegisterDeviceRequest{DeviceID: deviceID, PublicKey: "pk"})
	require.NoError(t, err)
	req := httptest.NewRequest("POST", "/devices/register", bytes.NewReader(body))
	req = req.WithContext(context.WithValue(req.Context(), auth.AccountIDKey, accountID))
	rr := httptest.NewRecorder()
	RegisterDevice(pool)(rr, req)
	require.Equal(t, http.StatusCreated, rr.Code)

	req2 := httptest.NewRequest("GET", "/devices", nil)
	req2 = req2.WithContext(context.WithValue(req2.Context(), auth.AccountIDKey, accountID))
	rr2 := httptest.NewRecorder()
	ListDevices(pool)(rr2, req2)
	require.Equal(t, http.StatusOK, rr2.Code)

	var devices []DeviceResponse
	require.NoError(t, json.Unmarshal(rr2.Body.Bytes(), &devices))
	require.Len(t, devices, 1)
	require.NotNil(t, devices[0].LastSeenAt, "registration must stamp last_seen_at")
	require.WithinDuration(t, time.Now(), *devices[0].LastSeenAt, time.Minute)
}
