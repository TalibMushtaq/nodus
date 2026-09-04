package handler

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/TalibMushtaq/nodus/services/relay/internal/auth"
	"github.com/TalibMushtaq/nodus/services/relay/internal/db"
)

type RegisterDeviceRequest struct {
	DeviceID  string `json:"device_id"`
	PublicKey string `json:"public_key"`
}

type DeviceResponse struct {
	DeviceID  string     `json:"device_id"`
	AccountID string     `json:"account_id"`
	PublicKey string     `json:"public_key"`
	Status    string     `json:"status"`
	CreatedAt time.Time  `json:"created_at"`
	RevokedAt *time.Time `json:"revoked_at,omitempty"`
}

// RegisterDevice registers a new cryptographic device identity for the authenticated account.
func RegisterDevice(pool *db.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		accountID, ok := auth.GetAccountID(r.Context())
		if !ok {
			respondError(w, http.StatusUnauthorized, "unauthorized")
			return
		}

		var req RegisterDeviceRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			respondError(w, http.StatusBadRequest, "invalid request body")
			return
		}

		if req.DeviceID == "" || req.PublicKey == "" {
			respondError(w, http.StatusBadRequest, "device_id and public_key are required")
			return
		}

		query := `
			INSERT INTO devices (device_id, account_id, public_key, status)
			VALUES ($1, $2, $3, 'ACTIVE')
			ON CONFLICT (device_id) DO UPDATE SET
				public_key = excluded.public_key,
				status = 'ACTIVE',
				revoked_at = NULL
			RETURNING device_id, account_id, public_key, status, created_at, revoked_at
		`

		var dev DeviceResponse
		err := pool.QueryRow(r.Context(), query, req.DeviceID, accountID, req.PublicKey).Scan(
			&dev.DeviceID,
			&dev.AccountID,
			&dev.PublicKey,
			&dev.Status,
			&dev.CreatedAt,
			&dev.RevokedAt,
		)
		if err != nil {
			respondError(w, http.StatusInternalServerError, "failed to register device")
			return
		}

		respondJSON(w, http.StatusCreated, dev)
	}
}

// ListDevices returns all registered devices for the authenticated account.
func ListDevices(pool *db.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		accountID, ok := auth.GetAccountID(r.Context())
		if !ok {
			respondError(w, http.StatusUnauthorized, "unauthorized")
			return
		}

		query := `
			SELECT device_id, account_id, public_key, status, created_at, revoked_at
			FROM devices
			WHERE account_id = $1
			ORDER BY created_at ASC
		`

		rows, err := pool.Query(r.Context(), query, accountID)
		if err != nil {
			respondError(w, http.StatusInternalServerError, "failed to query devices")
			return
		}
		defer rows.Close()

		devices := make([]DeviceResponse, 0)
		for rows.Next() {
			var dev DeviceResponse
			if err := rows.Scan(
				&dev.DeviceID,
				&dev.AccountID,
				&dev.PublicKey,
				&dev.Status,
				&dev.CreatedAt,
				&dev.RevokedAt,
			); err != nil {
				respondError(w, http.StatusInternalServerError, "failed to scan device")
				return
			}
			devices = append(devices, dev)
		}

		respondJSON(w, http.StatusOK, devices)
	}
}

// RevokeDevice marks a device as REVOKED and removes its key envelopes (per ADR-0001).
func RevokeDevice(pool *db.Pool) http.HandlerFunc {
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

		now := time.Now().UTC()
		query := `
			UPDATE devices
			SET status = 'REVOKED', revoked_at = $1
			WHERE device_id = $2 AND account_id = $3
		`

		res, err := pool.Exec(r.Context(), query, now, deviceID, accountID)
		if err != nil {
			respondError(w, http.StatusInternalServerError, "failed to revoke device")
			return
		}

		if res.RowsAffected() == 0 {
			respondError(w, http.StatusNotFound, "device not found")
			return
		}

		// Also delete any key envelopes associated with this device (ADR-0001)
		_, _ = pool.Exec(r.Context(), "DELETE FROM key_envelopes WHERE recipient_id = $1", deviceID)

		respondJSON(w, http.StatusOK, map[string]string{
			"status":    "REVOKED",
			"device_id": deviceID,
		})
	}
}
