package handler

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/TalibMushtaq/nodus/services/relay/internal/auth"
	"github.com/TalibMushtaq/nodus/services/relay/internal/db"
)

// maxDisplayNameLength caps a user-assigned node/device name. Kept short so a
// name always fits the Devices row without truncation games.
const maxDisplayNameLength = 64

type RenameRequest struct {
	Name string `json:"name"`
}

// normalizeDisplayName trims the input and enforces the length cap. An empty
// result means "clear the name" (stored as NULL so the client falls back to the
// peer id); a false second value means the cap was exceeded.
func normalizeDisplayName(name string) (string, bool) {
	trimmed := strings.TrimSpace(name)
	if len([]rune(trimmed)) > maxDisplayNameLength {
		return "", false
	}
	return trimmed, true
}

// RenameNode sets (or clears) a storage node's display name for the account.
func RenameNode(pool *db.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		accountID, ok := auth.GetAccountID(r.Context())
		if !ok {
			respondError(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		nodeID := r.PathValue("node_id")
		if nodeID == "" {
			respondError(w, http.StatusBadRequest, "node id is required")
			return
		}

		var req RenameRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			respondError(w, http.StatusBadRequest, "invalid request body")
			return
		}
		name, ok := normalizeDisplayName(req.Name)
		if !ok {
			respondError(w, http.StatusBadRequest, "name is too long")
			return
		}

		var updatedID string
		var displayName *string
		err := pool.QueryRow(r.Context(), `
			UPDATE storage_nodes
			SET display_name = NULLIF($1, '')
			WHERE node_id = $2 AND account_id = $3
			RETURNING node_id, display_name
		`, name, nodeID, accountID).Scan(&updatedID, &displayName)
		if errors.Is(err, pgx.ErrNoRows) {
			respondError(w, http.StatusNotFound, "node not found")
			return
		}
		if err != nil {
			respondError(w, http.StatusInternalServerError, "failed to rename node")
			return
		}
		respondJSON(w, http.StatusOK, map[string]any{"node_id": updatedID, "display_name": displayName})
	}
}

// RenameDevice sets (or clears) a client device's display name for the account.
func RenameDevice(pool *db.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		accountID, ok := auth.GetAccountID(r.Context())
		if !ok {
			respondError(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		deviceID := r.PathValue("id")
		if deviceID == "" {
			respondError(w, http.StatusBadRequest, "device id is required")
			return
		}

		var req RenameRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			respondError(w, http.StatusBadRequest, "invalid request body")
			return
		}
		name, ok := normalizeDisplayName(req.Name)
		if !ok {
			respondError(w, http.StatusBadRequest, "name is too long")
			return
		}

		var updatedID string
		var displayName *string
		err := pool.QueryRow(r.Context(), `
			UPDATE devices
			SET display_name = NULLIF($1, '')
			WHERE device_id = $2 AND account_id = $3
			RETURNING device_id, display_name
		`, name, deviceID, accountID).Scan(&updatedID, &displayName)
		if errors.Is(err, pgx.ErrNoRows) {
			respondError(w, http.StatusNotFound, "device not found")
			return
		}
		if err != nil {
			respondError(w, http.StatusInternalServerError, "failed to rename device")
			return
		}
		respondJSON(w, http.StatusOK, map[string]any{"device_id": updatedID, "display_name": displayName})
	}
}
