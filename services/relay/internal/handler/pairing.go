package handler

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/TalibMushtaq/nodus/services/relay/internal/auth"
	"github.com/TalibMushtaq/nodus/services/relay/internal/db"
	"github.com/TalibMushtaq/nodus/services/relay/internal/hub"
)

// ProtocolEnvelope is the canonical wire format declared in ws.go.

// PairingSessionRequest is the device-friendly body of POST /pairing/sessions.
// The device supplies which node it wants to pair with and its own device id;
// the *bound key* is taken from the registered device row, never from this
// body, so a token can only ever be redeemed by the key the account registered.
type PairingSessionRequest struct {
	NodeID   string `json:"node_id"`
	DeviceID string `json:"device_id"`
}

// PairingSessionResponse mirrors the local fast-path push fields so the
// client can render the QR before the node even processes the WS event.
type PairingSessionResponse struct {
	Token     string    `json:"token"`
	ExpiresAt time.Time `json:"expires_at"`
	NodeID    string    `json:"node_id"`
	DeviceID  string    `json:"device_id"`
}

// PairingTokenPushPayload is the WS push sent to the target node immediately
// after issuance (design decision E fast path). Registered as
// `pairing_token_push` in the TypeScript envelope catalog.
type PairingTokenPushPayload struct {
	NodeID          string `json:"node_id"`
	Token           string `json:"token"`
	DevicePublicKey string `json:"device_public_key"`
	ExpiresAt       string `json:"expires_at"`
	AccountID       string `json:"account_id"`
}

// How long a pairing token stays redeemable. Mirrors docs/security endpoints.
const pairingTokenTTL = 15 * time.Minute

// CreatePairingSession issues a device-bound token and pushes it to the node.
func CreatePairingSession(pool *db.Pool, wsHub *hub.Hub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		accountID, ok := auth.GetAccountID(r.Context())
		if !ok {
			respondError(w, http.StatusUnauthorized, "unauthorized")
			return
		}

		var req PairingSessionRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			respondError(w, http.StatusBadRequest, "invalid request body")
			return
		}
		if req.NodeID == "" || req.DeviceID == "" {
			respondError(w, http.StatusBadRequest, "node_id and device_id are required")
			return
		}

		// 1. The node must be a registered node of this account.
		var nodeExists bool
		err := pool.QueryRow(r.Context(),
			`SELECT EXISTS(SELECT 1 FROM storage_nodes
			              WHERE node_id = $1 AND account_id = $2 AND status = 'ACTIVE')`,
			req.NodeID, accountID,
		).Scan(&nodeExists)
		if err != nil {
			respondError(w, http.StatusInternalServerError, "failed to look up node")
			return
		}
		if !nodeExists {
			respondError(w, http.StatusNotFound, "node not found for this account")
			return
		}

		// 2. The device must be registered to this account and active; its
		//    registered public key is the one the token gets bound to.
		var devicePublicKey string
		err = pool.QueryRow(r.Context(),
			`SELECT public_key FROM devices
			 WHERE device_id = $1 AND account_id = $2 AND status = 'ACTIVE'`,
			req.DeviceID, accountID,
		).Scan(&devicePublicKey)
		if errors.Is(err, pgx.ErrNoRows) {
			respondError(w, http.StatusNotFound, "device not found for this account")
			return
		}
		if err != nil {
			respondError(w, http.StatusInternalServerError, "failed to look up device")
			return
		}

		// 3. Issue the token. Uniqueness is enforced by the UNIQUE constraint;
		//    a collision (uuid collision is effectively impossible) fails the insert.
		token := uuid.NewString()
		expiresAt := time.Now().Add(pairingTokenTTL)
		_, err = pool.Exec(r.Context(),
			`INSERT INTO pairing_sessions
			     (account_id, node_id, device_id, device_public_key, token, expires_at)
			 VALUES ($1, $2, $3, $4, $5, $6)`,
			accountID, req.NodeID, req.DeviceID, devicePublicKey, token, expiresAt,
		)
		if err != nil {
			respondError(w, http.StatusInternalServerError, "failed to create pairing session")
			return
		}

		// 4. Push to the node over its WS connection so /nodus/pair can redeem
		//    locally (fast path). If the node is offline, the push is a no-op
		//    and the token still works via the verify fallback.
		push := PairingTokenPushPayload{
			NodeID:          req.NodeID,
			Token:           token,
			DevicePublicKey: devicePublicKey,
			ExpiresAt:       expiresAt.UTC().Format(time.RFC3339),
			AccountID:       accountID,
		}
		payload, _ := json.Marshal(push)
		envelope := ProtocolEnvelope{
			Type:          "pairing_token_push",
			SchemaVersion: "1.0.0",
			MessageID:     uuid.NewString(),
			Timestamp:     time.Now().UTC().Format(time.RFC3339),
			Payload:       payload,
		}
		if msg, err := json.Marshal(envelope); err == nil && !wsHub.SendToNode(req.NodeID, msg) {
			log.Printf("[pairing] node %s not connected; token %s available via verify fallback", req.NodeID, token)
		}

		respondJSON(w, http.StatusCreated, PairingSessionResponse{
			Token:     token,
			ExpiresAt: expiresAt,
			NodeID:    req.NodeID,
			DeviceID:  req.DeviceID,
		})
	}
}

// VerifyPairingSession is the node's lazy fallback: /nodus/pair → Relay when
// the token was not pushed locally (node offline at issuance). Like
// /buffer/fetch, it is deliberately NOT JWT-protected — the token itself is
// the credential, and the node has no JWT.
func VerifyPairingSession(pool *db.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Token string `json:"token"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Token == "" {
			respondError(w, http.StatusBadRequest, "token is required")
			return
		}

		// Atomically consume the token on the first successful verify
		// (single-use, per docs/security/local-endpoints.md): the UPDATE only
		// matches an ACTIVE, unconsumed, unexpired row, and concurrent verifies
		// race on the row lock, so exactly one caller ever receives the data.
		// No row matched => token unknown, already consumed, or expired.
		var (
			accountID       string
			nodeID          string
			devicePublicKey string
			expiresAt       time.Time
		)
		err := pool.QueryRow(r.Context(),
			`UPDATE pairing_sessions
			 SET consumed_at = NOW()
			 WHERE token = $1
			   AND status = 'ACTIVE'
			   AND consumed_at IS NULL
			   AND expires_at > NOW()
			 RETURNING account_id, node_id, device_public_key, expires_at`,
			body.Token,
		).Scan(&accountID, &nodeID, &devicePublicKey, &expiresAt)
		if errors.Is(err, pgx.ErrNoRows) {
			respondJSON(w, http.StatusOK, map[string]interface{}{"valid": false})
			return
		}
		if err != nil {
			respondError(w, http.StatusInternalServerError, "failed to verify pairing session")
			return
		}

		respondJSON(w, http.StatusOK, map[string]interface{}{
			"valid":             true,
			"account_id":        accountID,
			"node_id":           nodeID,
			"device_public_key": devicePublicKey,
			"expires_at":        expiresAt.UTC().Format(time.RFC3339),
		})
	}
}

// VerifyNodeURL lets a client pre-flight a discovery result against the
// Relay before showing it as pair-able: is this a real, active node for the
// account? Open endpoint; the information it returns is low-sensitivity.
func VerifyNodeURL(pool *db.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		nodeID := r.URL.Query().Get("node_id")
		if nodeID == "" {
			respondError(w, http.StatusBadRequest, "node_id query parameter is required")
			return
		}

		var found string
		err := pool.QueryRow(r.Context(),
			`SELECT node_id FROM storage_nodes WHERE node_id = $1 AND status = 'ACTIVE'`,
			nodeID,
		).Scan(&found)
		if errors.Is(err, pgx.ErrNoRows) {
			respondJSON(w, http.StatusOK, map[string]interface{}{"valid": false, "node_id": nodeID})
			return
		}
		if err != nil {
			respondError(w, http.StatusInternalServerError, "failed to verify node")
			return
		}

		respondJSON(w, http.StatusOK, map[string]interface{}{"valid": true, "node_id": found})
	}
}
