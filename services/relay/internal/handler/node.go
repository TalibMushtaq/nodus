package handler

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/TalibMushtaq/nodus/services/relay/internal/auth"
	"github.com/TalibMushtaq/nodus/services/relay/internal/db"
)

type RegisterNodeRequest struct {
	NodeID       string   `json:"node_id"`
	PublicKey    string   `json:"public_key"`
	Capabilities []string `json:"capabilities"`
}

type NodeResponse struct {
	NodeID       string     `json:"node_id"`
	AccountID    string     `json:"account_id"`
	PublicKey    string     `json:"public_key"`
	Capabilities []string   `json:"capabilities"`
	Status       string     `json:"status"`
	IsPrimary    bool       `json:"is_primary"`
	LastSeenAt   *time.Time `json:"last_seen_at,omitempty"`
	CreatedAt    time.Time  `json:"created_at"`
}

// RegisterNode registers a storage node identity for the account.
func RegisterNode(pool *db.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		accountID, ok := auth.GetAccountID(r.Context())
		if !ok {
			respondError(w, http.StatusUnauthorized, "unauthorized")
			return
		}

		var req RegisterNodeRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			respondError(w, http.StatusBadRequest, "invalid request body")
			return
		}

		if req.NodeID == "" || req.PublicKey == "" {
			respondError(w, http.StatusBadRequest, "node_id and public_key are required")
			return
		}

		if req.Capabilities == nil {
			req.Capabilities = []string{"storage", "sync"}
		}

		capsJSON, err := json.Marshal(req.Capabilities)
		if err != nil {
			respondError(w, http.StatusBadRequest, "invalid capabilities")
			return
		}

		// Registration goes through the shared helper so this path and
		// /pairing/codes/redeem enforce the same node-identity invariant:
		// same node_id + same key is idempotent (no key replacement, no
		// reactivation), a changed key is rejected with node_key_mismatch, and
		// the first node for an account is primary (DB-enforced by
		// idx_storage_nodes_one_primary).
		tx, err := pool.Begin(r.Context())
		if err != nil {
			respondError(w, http.StatusInternalServerError, "failed to register storage node")
			return
		}
		defer tx.Rollback(r.Context())

		node, outcome, err := registerStorageNode(
			r.Context(), tx, accountID, req.NodeID, req.PublicKey, string(capsJSON),
		)
		if err != nil {
			respondError(w, http.StatusInternalServerError, "failed to register storage node")
			return
		}
		switch outcome {
		case nodeRegistrationOwnedElsewhere:
			// Preserve the historical message for this path.
			respondError(w, http.StatusConflict, "node_id is registered to another account")
			return
		case nodeRegistrationKeyMismatch:
			respondError(w, http.StatusConflict, outcome.errorReason())
			return
		}

		if err := tx.Commit(r.Context()); err != nil {
			respondError(w, http.StatusInternalServerError, "failed to register storage node")
			return
		}
		respondJSON(w, http.StatusCreated, node)
	}
}

// ListNodes returns all registered storage nodes for the account.
func ListNodes(pool *db.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		accountID, ok := auth.GetAccountID(r.Context())
		if !ok {
			respondError(w, http.StatusUnauthorized, "unauthorized")
			return
		}

		query := `
			SELECT node_id, account_id, public_key, capabilities, status, is_primary, last_seen_at, created_at
			FROM storage_nodes
			WHERE account_id = $1
			ORDER BY created_at ASC
		`

		rows, err := pool.Query(r.Context(), query, accountID)
		if err != nil {
			respondError(w, http.StatusInternalServerError, "failed to query storage nodes")
			return
		}
		defer rows.Close()

		nodes := make([]NodeResponse, 0)
		for rows.Next() {
			var (
				node      NodeResponse
				capsRaw   []byte
				isPrimary bool
			)
			if err := rows.Scan(
				&node.NodeID,
				&node.AccountID,
				&node.PublicKey,
				&capsRaw,
				&node.Status,
				&isPrimary,
				&node.LastSeenAt,
				&node.CreatedAt,
			); err != nil {
				respondError(w, http.StatusInternalServerError, "failed to scan storage node")
				return
			}
			node.IsPrimary = isPrimary
			_ = json.Unmarshal(capsRaw, &node.Capabilities)
			nodes = append(nodes, node)
		}

		respondJSON(w, http.StatusOK, nodes)
	}
}
