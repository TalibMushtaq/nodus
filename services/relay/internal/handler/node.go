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

		// v1 primary designation: the first Storage Node paired to an account is
		// primary automatically; every subsequent node defaults to is_primary = false.
		// On upsert (re-registration) is_primary is left untouched.
		query := `
			INSERT INTO storage_nodes (node_id, account_id, public_key, capabilities, status, is_primary)
			VALUES ($1, $2, $3, $4, 'ACTIVE',
			        NOT EXISTS (SELECT 1 FROM storage_nodes WHERE account_id = $2))
			ON CONFLICT (node_id) DO UPDATE SET
				public_key = excluded.public_key,
				capabilities = excluded.capabilities,
				status = 'ACTIVE'
			RETURNING node_id, account_id, public_key, capabilities, status, last_seen_at, created_at, is_primary
		`

		var (
			node      NodeResponse
			capsRaw   []byte
			isPrimary bool
		)

		err = pool.QueryRow(r.Context(), query, req.NodeID, accountID, req.PublicKey, capsJSON).Scan(
			&node.NodeID,
			&node.AccountID,
			&node.PublicKey,
			&capsRaw,
			&node.Status,
			&node.LastSeenAt,
			&node.CreatedAt,
			&isPrimary,
		)
		if err != nil {
			respondError(w, http.StatusInternalServerError, "failed to register storage node")
			return
		}

		node.IsPrimary = isPrimary

		_ = json.Unmarshal(capsRaw, &node.Capabilities)
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
