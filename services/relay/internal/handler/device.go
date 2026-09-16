package handler

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/TalibMushtaq/nodus/services/relay/internal/auth"
	"github.com/TalibMushtaq/nodus/services/relay/internal/db"
	"golang.org/x/crypto/curve25519"
)

// errDeviceOwnedElsewhere is returned by upsertDeviceForAccount when a
// device_id already exists under a different account; callers map it to 409.
var errDeviceOwnedElsewhere = errors.New("device_id registered to another account")

// normalizeEncryptionPublicKey trims and validates a device's published X25519
// encryption key (ADR-0008). An empty/omitted key is allowed — the device keeps
// (or has) no published key. A non-empty value must be 32-byte base64, however:
// a malformed key would be stored and later throw in every client's recipient
// collector, breaking envelope sealing for the whole account.
func normalizeEncryptionPublicKey(key string) (string, bool) {
	trimmed := strings.TrimSpace(key)
	if trimmed == "" {
		return "", true
	}
	decoded, err := base64.StdEncoding.DecodeString(trimmed)
	if err != nil || len(decoded) != curve25519.PointSize {
		return "", false
	}
	return trimmed, true
}

type dbQuerier interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

// upsertDeviceForAccount registers (or re-activates) a device, but refuses to
// do so when the device_id already belongs to another account: the DO UPDATE
// WHERE clause pins the upsert to this account's own row, so a foreign
// collision yields zero returned rows (ErrNoRows) instead of silently
// overwriting the other account's public_key/status.
func upsertDeviceForAccount(q dbQuerier, r *http.Request, deviceID, publicKey, encryptionPublicKey, accountID string) (*DeviceResponse, error) {
	var dev DeviceResponse
	// `last_seen_at` is stamped here as well as on the WS heartbeat so a device
	// that just registered reads as active immediately, without waiting up to a
	// minute for the presence write to catch up.
	//
	// `COALESCE(excluded, devices)` keeps a published X25519 key (ADR-0008) when
	// a request omits it: an older client that only knows the Ed25519 identity
	// must not wipe the key its peers seal to.
	err := q.QueryRow(r.Context(), `
		INSERT INTO devices (device_id, account_id, public_key, encryption_public_key, status, last_seen_at)
		VALUES ($1, $2, $3, nullif($4, ''), 'ACTIVE', NOW())
		ON CONFLICT (device_id) DO UPDATE SET
			public_key = excluded.public_key,
			encryption_public_key = COALESCE(excluded.encryption_public_key, devices.encryption_public_key),
			status = 'ACTIVE',
			revoked_at = NULL,
			last_seen_at = NOW()
		WHERE devices.account_id = excluded.account_id
		RETURNING device_id, account_id, public_key, encryption_public_key, status, created_at, revoked_at, display_name, last_seen_at
	`, deviceID, accountID, publicKey, encryptionPublicKey).Scan(
		&dev.DeviceID,
		&dev.AccountID,
		&dev.PublicKey,
		&dev.EncryptionPublicKey,
		&dev.Status,
		&dev.CreatedAt,
		&dev.RevokedAt,
		&dev.DisplayName,
		&dev.LastSeenAt,
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
	// EncryptionPublicKey is the device's X25519 key (base64, ADR-0008).
	// Optional: a device without one keeps the Ed25519-derived envelope key.
	EncryptionPublicKey string `json:"encryption_public_key"`
}

type DeviceResponse struct {
	DeviceID  string `json:"device_id"`
	AccountID string `json:"account_id"`
	PublicKey string `json:"public_key"`
	// EncryptionPublicKey is the X25519 key senders seal envelopes to, when the
	// device has published one (ADR-0008).
	EncryptionPublicKey *string    `json:"encryption_public_key,omitempty"`
	Status              string     `json:"status"`
	DisplayName         *string    `json:"display_name,omitempty"`
	CreatedAt           time.Time  `json:"created_at"`
	RevokedAt           *time.Time `json:"revoked_at,omitempty"`
	// Last WS heartbeat/registration. Nil for devices seen before presence was
	// persisted, which the web client renders as "unknown" rather than "offline".
	LastSeenAt *time.Time `json:"last_seen_at,omitempty"`
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

		encryptionKey, ok := normalizeEncryptionPublicKey(req.EncryptionPublicKey)
		if !ok {
			respondError(w, http.StatusBadRequest, "encryption_public_key must be a 32-byte base64 X25519 public key")
			return
		}

		dev, err := upsertDeviceForAccount(pool, r, req.DeviceID, req.PublicKey, encryptionKey, accountID)
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
			SELECT device_id, account_id, public_key, encryption_public_key, status, created_at, revoked_at, display_name, last_seen_at
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
				&dev.EncryptionPublicKey,
				&dev.Status,
				&dev.CreatedAt,
				&dev.RevokedAt,
				&dev.DisplayName,
				&dev.LastSeenAt,
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

		// Also delete any key envelopes associated with this device (ADR-0001).
		// Folder-key envelopes must go too, or a revoked device keeps a usable
		// folder-name key.
		_, _ = pool.Exec(r.Context(), "DELETE FROM key_envelopes WHERE recipient_id = $1", deviceID)
		_, _ = pool.Exec(r.Context(), "DELETE FROM folder_key_envelopes WHERE recipient_id = $1", deviceID)

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
