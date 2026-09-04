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

		query := `
			INSERT INTO storage_nodes (node_id, account_id, public_key, capabilities, status)
			VALUES ($1, $2, $3, $4, 'ACTIVE')
			ON CONFLICT (node_id) DO UPDATE SET
				public_key = excluded.public_key,
				capabilities = excluded.capabilities,
				status = 'ACTIVE'
			RETURNING node_id, account_id, public_key, capabilities, status, last_seen_at, created_at
		`

		var (
			node    NodeResponse
			capsRaw []byte
		)

		err = pool.QueryRow(r.Context(), query, req.NodeID, accountID, req.PublicKey, capsJSON).Scan(
			&node.NodeID,
			&node.AccountID,
			&node.PublicKey,
			&capsRaw,
			&node.Status,
			&node.LastSeenAt,
			&node.CreatedAt,
		)
		if err != nil {
			respondError(w, http.StatusInternalServerError, "failed to register storage node")
			return
		}

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
			SELECT node_id, account_id, public_key, capabilities, status, last_seen_at, created_at
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
				node    NodeResponse
				capsRaw []byte
			)
			if err := rows.Scan(
				&node.NodeID,
				&node.AccountID,
				&node.PublicKey,
				&capsRaw,
				&node.Status,
				&node.LastSeenAt,
				&node.CreatedAt,
			); err != nil {
				respondError(w, http.StatusInternalServerError, "failed to scan storage node")
				return
			}
			_ = json.Unmarshal(capsRaw, &node.Capabilities)
			nodes = append(nodes, node)
		}

		respondJSON(w, http.StatusOK, nodes)
	}
}
