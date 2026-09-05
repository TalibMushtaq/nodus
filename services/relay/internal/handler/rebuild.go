package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"time"

	"github.com/TalibMushtaq/nodus/services/relay/internal/auth"
	"github.com/TalibMushtaq/nodus/services/relay/internal/db"
	"github.com/TalibMushtaq/nodus/services/relay/internal/hub"
	"github.com/google/uuid"
)

// ── Rebuild trigger ────────────────────────────────────────────────
// A rebuild is served only by the account's designated primary Storage Node.
// If the primary is offline, the request is queued in rebuild_requests and
// delivered when the primary reconnects — never silently rerouted to a
// non-primary node.

// validRebuildReasons are the only accepted `reason` values, mirroring the
// RebuildRequiredPayloadSchema enum (admin | restore | schema_mismatch).
var validRebuildReasons = map[string]bool{
	"admin":           true,
	"restore":         true,
	"schema_mismatch": true,
}

// validateRebuildReason rejects reasons outside the protocol enum. Unknown
// reasons otherwise reach the node's enum validation and muddy audit trails.
func validateRebuildReason(reason string) error {
	if !validRebuildReasons[reason] {
		return fmt.Errorf("invalid reason: must be one of admin, restore, schema_mismatch")
	}
	return nil
}

type RebuildRequestPayload struct {
	Reason string `json:"reason"`
}

type RebuildResponse struct {
	AccountID string `json:"account_id"`
	NodeID    string `json:"node_id"`
	Status    string `json:"status"` // "delivered" | "queued"
	QueuedAt  string `json:"queued_at,omitempty"`
}

// RequestRebuild is the admin/manual HTTP trigger. It looks up the account's
// primary node and either sends REBUILD_REQUIRED immediately (if online) or
// queues the request for delivery once the primary reconnects.
func RequestRebuild(pool *db.Pool, h *hub.Hub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		accountID, ok := auth.GetAccountID(r.Context())
		if !ok {
			respondError(w, http.StatusUnauthorized, "unauthorized")
			return
		}

		var req RebuildRequestPayload
		if r.Body != nil {
			_ = json.NewDecoder(r.Body).Decode(&req)
		}
		if req.Reason == "" {
			req.Reason = "admin"
		}
		// Reject unknown reasons explicitly rather than silently accepting them:
		// a misspelled reason otherwise reaches the node's enum validation and
		// muddies audit trails. A missing body defaults to 'admin' above.
		if err := validateRebuildReason(req.Reason); err != nil {
			respondError(w, http.StatusBadRequest, err.Error())
			return
		}

		// Locate this account's primary node.
		var nodeID string
		err := pool.QueryRow(r.Context(), `
			SELECT node_id FROM storage_nodes
			WHERE account_id = $1 AND is_primary = true AND status = 'ACTIVE'
		`, accountID).Scan(&nodeID)
		if err != nil {
			respondError(w, http.StatusNotFound, "account has no primary storage node")
			return
		}

		msg := buildRebuildRequired(nodeID, req.Reason)

		// Route now if the primary is connected, otherwise queue and wait.
		delivered := h.SendToNode(nodeID, msg)

		queuedAt := time.Now().UTC()
		_, _ = pool.Exec(r.Context(), `
			INSERT INTO rebuild_requests (account_id, node_id, reason, status)
			VALUES ($1, $2, $3, $4)
		`, accountID, nodeID, req.Reason, map[bool]string{true: "delivered", false: "pending"}[delivered])

		status := "delivered"
		resp := RebuildResponse{AccountID: accountID, NodeID: nodeID, Status: status}
		if !delivered {
			resp.Status = "queued"
			resp.QueuedAt = queuedAt.Format(time.RFC3339)
			log.Printf("[rebuild] primary node %s offline; queued rebuild for account %s", nodeID, accountID)
		} else {
			log.Printf("[rebuild] REBUILD_REQUIRED sent to primary node %s for account %s", nodeID, accountID)
		}
		respondJSON(w, http.StatusAccepted, resp)
	}
}

// deliverPendingRebuildRequests sends any queued REBUILD_REQUIRED requests to a
// node that just authenticated, if that node is the account's primary.
func deliverPendingRebuildRequests(ctx context.Context, pool *db.Pool, h *hub.Hub, accountID, nodeID string) {
	rows, err := pool.Query(ctx, `
		SELECT id, reason FROM rebuild_requests
		WHERE account_id = $1 AND node_id = $2 AND status = 'pending'
		ORDER BY created_at ASC
	`, accountID, nodeID)
	if err != nil {
		return
	}
	defer rows.Close()

	type pending struct {
		id     int64
		reason string
	}
	var items []pending
	for rows.Next() {
		var p pending
		if err := rows.Scan(&p.id, &p.reason); err != nil {
			continue
		}
		items = append(items, p)
	}

	for _, p := range items {
		msg := buildRebuildRequired(nodeID, p.reason)
		if h.SendToNode(nodeID, msg) {
			_, _ = pool.Exec(ctx, `
				UPDATE rebuild_requests SET status = 'delivered', delivered_at = NOW()
				WHERE id = $1 AND status = 'pending'
			`, p.id)
		}
	}
}

func buildRebuildRequired(nodeID, reason string) []byte {
	if reason == "" {
		reason = "admin"
	}
	payload := map[string]any{
		"node_id": nodeID,
		"reason":  reason,
	}
	payloadBytes, _ := json.Marshal(payload)
	env := ProtocolEnvelope{
		Type:          "rebuild_required",
		SchemaVersion: "1.0.0",
		MessageID:     uuid.NewString(),
		Timestamp:     time.Now().UTC().Format(time.RFC3339),
		Payload:       payloadBytes,
	}
	envBytes, _ := json.Marshal(env)
	return envBytes
}
