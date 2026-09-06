package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/TalibMushtaq/nodus/services/relay/internal/auth"
	"github.com/TalibMushtaq/nodus/services/relay/internal/config"
	"github.com/TalibMushtaq/nodus/services/relay/internal/db"
	"github.com/TalibMushtaq/nodus/services/relay/internal/hub"
)

// pairingHarness bundles the live Postgres resources and seeded fixture rows
// the pairing handlers need. CreatePairingSession requires a node + registered
// device belonging to the account; VerifyPairingSession only needs the table.
type pairingHarness struct {
	ctx       context.Context
	cancel    context.CancelFunc
	pool      *db.Pool
	hub       *hub.Hub
	accountID string
	nodeID    string
	deviceID  string
	deviceKey string
}

func setupPairingHarness(t *testing.T) *pairingHarness {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set; skipping integration test")
	}

	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	if err := db.RunMigrations(url); err != nil {
		t.Fatalf("run migrations: %v", err)
	}
	pool, err := db.Open(ctx, &config.Config{DatabaseURL: url})
	if err != nil {
		t.Fatalf("open pool: %v", err)
	}
	t.Cleanup(pool.Close)

	h := &pairingHarness{
		ctx:       ctx,
		cancel:    cancel,
		pool:      pool,
		accountID: "acct-pairing",
		nodeID:    "node-pairing",
		deviceID:  "dev-pairing",
		deviceKey: "ZmFrZS1kZXZpY2Uta2V5",
	}
	h.hub = hub.New(nil)
	go h.hub.Run(ctx)

	seed := []struct {
		q    string
		args []any
	}{
		{
			q:    `INSERT INTO accounts (account_id, email, password_hash) VALUES ($1, 'pairing@test.local', 'x') ON CONFLICT DO NOTHING`,
			args: []any{h.accountID},
		},
		{
			q:    `INSERT INTO storage_nodes (node_id, account_id, public_key) VALUES ($1, $2, 'deadbeef') ON CONFLICT DO NOTHING`,
			args: []any{h.nodeID, h.accountID},
		},
		{
			q:    `INSERT INTO devices (device_id, account_id, public_key) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
			args: []any{h.deviceID, h.accountID, h.deviceKey},
		},
	}
	for _, s := range seed {
		_, err := pool.Exec(ctx, s.q, s.args...)
		require.NoError(t, err, "seed query failed: %s", s.q)
	}

	return h
}

// createSession drives POST /pairing/sessions with the account ID injected
// directly into the context, mirroring what RequireAuth would have done.
func (h *pairingHarness) createSession(t *testing.T, nodeID, deviceID string) *httptest.ResponseRecorder {
	t.Helper()
	body, err := json.Marshal(PairingSessionRequest{NodeID: nodeID, DeviceID: deviceID})
	require.NoError(t, err)
	req := httptest.NewRequest("POST", "/pairing/sessions", bytes.NewReader(body))
	req = req.WithContext(context.WithValue(req.Context(), auth.AccountIDKey, h.accountID))
	rr := httptest.NewRecorder()
	CreatePairingSession(h.pool, h.hub)(rr, req)
	return rr
}

// verifySession drives POST /pairing/sessions/verify (the unauthenticated node
// fallback) with the given token.
func (h *pairingHarness) verifySession(t *testing.T, token string) *httptest.ResponseRecorder {
	t.Helper()
	body, err := json.Marshal(map[string]string{"token": token})
	require.NoError(t, err)
	req := httptest.NewRequest("POST", "/pairing/sessions/verify", bytes.NewReader(body))
	rr := httptest.NewRecorder()
	VerifyPairingSession(h.pool)(rr, req)
	return rr
}

func (h *pairingHarness) consumedAt(t *testing.T, token string) *time.Time {
	t.Helper()
	var consumedAt *time.Time
	err := h.pool.QueryRow(h.ctx,
		`SELECT consumed_at FROM pairing_sessions WHERE token = $1`, token).Scan(&consumedAt)
	require.NoError(t, err)
	return consumedAt
}

func TestCreatePairingSessionSuccess(t *testing.T) {
	h := setupPairingHarness(t)

	rr := h.createSession(t, h.nodeID, h.deviceID)
	require.Equal(t, http.StatusCreated, rr.Code)

	var resp PairingSessionResponse
	require.NoError(t, json.NewDecoder(rr.Body).Decode(&resp))
	require.NotEmpty(t, resp.Token)
	require.Equal(t, h.nodeID, resp.NodeID)
	require.Equal(t, h.deviceID, resp.DeviceID)
	require.False(t, resp.ExpiresAt.IsZero())

	// The issued window must be the 15-minute TTL, and the stored row binds
	// the token to the *registered* key, not anything the request supplied.
	_, err := uuid.Parse(resp.Token)
	require.NoError(t, err, "token should be a UUID")
	require.InDelta(t, 15*time.Minute.Seconds(), time.Until(resp.ExpiresAt).Seconds(), 60)

	var storedKey string
	var status string
	err = h.pool.QueryRow(h.ctx,
		`SELECT device_public_key, status FROM pairing_sessions WHERE token = $1`, resp.Token,
	).Scan(&storedKey, &status)
	require.NoError(t, err)
	require.Equal(t, h.deviceKey, storedKey)
	require.Equal(t, "ACTIVE", status)
	require.Nil(t, h.consumedAt(t, resp.Token), "freshly issued token must be unconsumed")
}

func TestCreatePairingSessionNodeNotFound(t *testing.T) {
	h := setupPairingHarness(t)

	rr := h.createSession(t, "node-unknown", h.deviceID)
	require.Equal(t, http.StatusNotFound, rr.Code)
}

func TestCreatePairingSessionDeviceNotFound(t *testing.T) {
	h := setupPairingHarness(t)

	rr := h.createSession(t, h.nodeID, "dev-unknown")
	require.Equal(t, http.StatusNotFound, rr.Code)
}

func TestVerifyPairingSessionValidConsumesToken(t *testing.T) {
	h := setupPairingHarness(t)

	created := h.createSession(t, h.nodeID, h.deviceID)
	require.Equal(t, http.StatusCreated, created.Code)
	var session PairingSessionResponse
	require.NoError(t, json.NewDecoder(created.Body).Decode(&session))

	rr := h.verifySession(t, session.Token)
	require.Equal(t, http.StatusOK, rr.Code)

	var resp struct {
		Valid           bool   `json:"valid"`
		AccountID       string `json:"account_id"`
		NodeID          string `json:"node_id"`
		DevicePublicKey string `json:"device_public_key"`
	}
	require.NoError(t, json.NewDecoder(rr.Body).Decode(&resp))
	require.True(t, resp.Valid)
	require.Equal(t, h.accountID, resp.AccountID)
	require.Equal(t, h.nodeID, resp.NodeID)
	require.Equal(t, h.deviceKey, resp.DevicePublicKey)

	require.NotNil(t, h.consumedAt(t, session.Token), "successful verify must set consumed_at")
}

func TestVerifyPairingSessionRejectsReplay(t *testing.T) {
	h := setupPairingHarness(t)

	created := h.createSession(t, h.nodeID, h.deviceID)
	require.Equal(t, http.StatusCreated, created.Code)
	var session PairingSessionResponse
	require.NoError(t, json.NewDecoder(created.Body).Decode(&session))

	first := h.verifySession(t, session.Token)
	require.Equal(t, http.StatusOK, first.Code)

	second := h.verifySession(t, session.Token)
	require.Equal(t, http.StatusOK, second.Code)
	var resp struct {
		Valid bool `json:"valid"`
	}
	require.NoError(t, json.NewDecoder(second.Body).Decode(&resp))
	require.False(t, resp.Valid, "a consumed token must not verify twice")
}

func TestVerifyPairingSessionRejectsExpired(t *testing.T) {
	h := setupPairingHarness(t)

	// Seed an already-expired, unconsumed token directly. Verifying it must
	// fail and must NOT consume it (the WHERE guard excludes expired rows).
	expiredToken := uuid.NewString()
	_, err := h.pool.Exec(h.ctx,
		`INSERT INTO pairing_sessions
		     (account_id, node_id, device_id, device_public_key, token, expires_at)
		 VALUES ($1, $2, $3, $4, $5, NOW() - interval '1 minute')`,
		h.accountID, h.nodeID, h.deviceID, h.deviceKey, expiredToken)
	require.NoError(t, err)

	rr := h.verifySession(t, expiredToken)
	require.Equal(t, http.StatusOK, rr.Code)
	var resp struct {
		Valid bool `json:"valid"`
	}
	require.NoError(t, json.NewDecoder(rr.Body).Decode(&resp))
	require.False(t, resp.Valid)
	require.Nil(t, h.consumedAt(t, expiredToken), "expired token must not be marked consumed")
}

func TestVerifyPairingSessionRejectsUnknownToken(t *testing.T) {
	h := setupPairingHarness(t)

	rr := h.verifySession(t, uuid.NewString())
	require.Equal(t, http.StatusOK, rr.Code)
	var resp struct {
		Valid bool `json:"valid"`
	}
	require.NoError(t, json.NewDecoder(rr.Body).Decode(&resp))
	require.False(t, resp.Valid)
}
