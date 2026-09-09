package handler

import (
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/TalibMushtaq/nodus/services/relay/internal/auth"
	"github.com/TalibMushtaq/nodus/services/relay/internal/db"
)

// errDeviceOwnedElsewhere is returned by upsertDeviceForAccount when a
// device_id already exists under a different account; callers map it to 409.
var errDeviceOwnedElsewhere = errors.New("device_id registered to another account")

// upsertDeviceForAccount registers (or re-activates) a device, but refuses to
// do so when the device_id already belongs to another account: the DO UPDATE
// WHERE clause pins the upsert to this account's own row, so a foreign
// collision yields zero returned rows (ErrNoRows) instead of silently
// overwriting the other account's public_key/status.
func upsertDeviceForAccount(pool *db.Pool, r *http.Request, deviceID, publicKey, accountID string) (*DeviceResponse, error) {
	var dev DeviceResponse
	err := pool.QueryRow(r.Context(), `
		INSERT INTO devices (device_id, account_id, public_key, status)
		VALUES ($1, $2, $3, 'ACTIVE')
		ON CONFLICT (device_id) DO UPDATE SET
			public_key = excluded.public_key,
			status = 'ACTIVE',
			revoked_at = NULL
		WHERE devices.account_id = excluded.account_id
		RETURNING device_id, account_id, public_key, status, created_at, revoked_at
	`, deviceID, accountID, publicKey).Scan(
		&dev.DeviceID,
		&dev.AccountID,
		&dev.PublicKey,
		&dev.Status,
		&dev.CreatedAt,
		&dev.RevokedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errDeviceOwnedElsewhere
	}
	if err != nil {
		return nil, err
	}
	return &dev, nil
}

// respondDeviceUpsertError maps the ownership conflict to 409 and any other
// failure to 500.
func respondDeviceUpsertError(w http.ResponseWriter, err error) {
	if errors.Is(err, errDeviceOwnedElsewhere) {
		respondError(w, http.StatusConflict, "device_id is registered to another account")
		return
	}
	respondError(w, http.StatusInternalServerError, "failed to register device")
}

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

// RegisterDevice registers a new cryptographic device identity for the
// authenticated account. Same ownership-safe upsert as the login/auth path so a
// device_id belonging to another account is rejected, not hijacked.
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

		dev, err := upsertDeviceForAccount(pool, r, req.DeviceID, req.PublicKey, accountID)
		if err != nil {
			respondDeviceUpsertError(w, err)
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

// RevokeDevice marks a device as REVOKED, removes its key envelopes
// (per ADR-0001), and immediately kills every session bound to it so a
// lost/compromised device cannot keep an authenticated session alive (§2).
func RevokeDevice(pool *db.Pool, store auth.SessionStore) http.HandlerFunc {
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

		// Revoke all sessions bound to the revoked device.
		if err := store.RevokeAllForDevice(r.Context(), deviceID); err != nil {
			respondError(w, http.StatusInternalServerError, "failed to revoke device sessions")
			return
		}

		respondJSON(w, http.StatusOK, map[string]string{
			"status":    "REVOKED",
			"device_id": deviceID,
		})
	}
}
