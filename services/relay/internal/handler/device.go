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

// DeviceInfo is the display-only platform metadata a client reports at
// login/register. It is free text (never trusted for auth) so the Devices list
// can show "iPhone · iOS 17 · Nodus 1.4" instead of a bare device id.
type DeviceInfo struct {
	Platform   string `json:"platform"`
	OSVersion  string `json:"os_version"`
	Browser    string `json:"browser"`
	AppVersion string `json:"app_version"`
	UserAgent  string `json:"user_agent"`
}

// sanitizeDeviceField trims whitespace, treats empty as absent, and caps the
// length (by runes, so a multi-byte model name is not split mid-character).
// Bounded because this is request-controlled text echoed back to every client.
func sanitizeDeviceField(value string, maxRunes int) *string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return nil
	}
	if runes := []rune(trimmed); len(runes) > maxRunes {
		trimmed = string(runes[:maxRunes])
	}
	return &trimmed
}

// deviceInfoColumns projects a request's DeviceInfo into nullable column values.
func deviceInfoColumns(info *DeviceInfo) (platform, osVersion, browser, appVersion, userAgent *string) {
	if info == nil {
		return nil, nil, nil, nil, nil
	}
	return sanitizeDeviceField(info.Platform, 32),
		sanitizeDeviceField(info.OSVersion, 48),
		sanitizeDeviceField(info.Browser, 64),
		sanitizeDeviceField(info.AppVersion, 48),
		sanitizeDeviceField(info.UserAgent, 256)
}

// deviceInfoFromColumns rebuilds the response object, or nil when nothing was
// ever reported (older clients), so the field can be omitted entirely.
func deviceInfoFromColumns(platform, osVersion, browser, appVersion, userAgent *string) *DeviceInfo {
	if platform == nil && osVersion == nil && browser == nil && appVersion == nil && userAgent == nil {
		return nil
	}
	info := &DeviceInfo{}
	if platform != nil {
		info.Platform = *platform
	}
	if osVersion != nil {
		info.OSVersion = *osVersion
	}
	if browser != nil {
		info.Browser = *browser
	}
	if appVersion != nil {
		info.AppVersion = *appVersion
	}
	if userAgent != nil {
		info.UserAgent = *userAgent
	}
	return info
}

// upsertDeviceForAccount registers (or re-activates) a device, but refuses to
// do so when the device_id already belongs to another account: the DO UPDATE
// WHERE clause pins the upsert to this account's own row, so a foreign
// collision yields zero returned rows (ErrNoRows) instead of silently
// overwriting the other account's public_key/status.
func upsertDeviceForAccount(q dbQuerier, r *http.Request, deviceID, publicKey, encryptionPublicKey, accountID string, info *DeviceInfo) (*DeviceResponse, error) {
	var dev DeviceResponse
	var (
		platform   *string
		osVersion  *string
		browser    *string
		appVersion *string
		userAgent  *string
	)
	platform, osVersion, browser, appVersion, userAgent = deviceInfoColumns(info)
	// `last_seen_at` is stamped here as well as on the WS heartbeat so a device
	// that just registered reads as active immediately, without waiting up to a
	// minute for the presence write to catch up.
	//
	// `COALESCE(excluded, devices)` keeps a published X25519 key (ADR-0008) and
	// any previously reported device info when a request omits them: an older
	// client that only knows the Ed25519 identity must not wipe the key its
	// peers seal to, nor blank the platform label a richer client reported.
	err := q.QueryRow(r.Context(), `
		INSERT INTO devices (device_id, account_id, public_key, encryption_public_key, status, last_seen_at,
		                     platform, os_version, browser, app_version, user_agent)
		VALUES ($1, $2, $3, nullif($4, ''), 'ACTIVE', NOW(), $5, $6, $7, $8, $9)
		ON CONFLICT (device_id) DO UPDATE SET
			public_key = excluded.public_key,
			encryption_public_key = COALESCE(excluded.encryption_public_key, devices.encryption_public_key),
			status = 'ACTIVE',
			revoked_at = NULL,
			last_seen_at = NOW(),
			platform = COALESCE(excluded.platform, devices.platform),
			os_version = COALESCE(excluded.os_version, devices.os_version),
			browser = COALESCE(excluded.browser, devices.browser),
			app_version = COALESCE(excluded.app_version, devices.app_version),
			user_agent = COALESCE(excluded.user_agent, devices.user_agent)
		WHERE devices.account_id = excluded.account_id
		RETURNING device_id, account_id, public_key, encryption_public_key, status, created_at, revoked_at, display_name, last_seen_at,
		          platform, os_version, browser, app_version, user_agent
	`, deviceID, accountID, publicKey, encryptionPublicKey,
		platform, osVersion, browser, appVersion, userAgent).Scan(
		&dev.DeviceID,
		&dev.AccountID,
		&dev.PublicKey,
		&dev.EncryptionPublicKey,
		&dev.Status,
		&dev.CreatedAt,
		&dev.RevokedAt,
		&dev.DisplayName,
		&dev.LastSeenAt,
		&platform,
		&osVersion,
		&browser,
		&appVersion,
		&userAgent,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errDeviceOwnedElsewhere
	}
	if err != nil {
		return nil, err
	}
	dev.DeviceInfo = deviceInfoFromColumns(platform, osVersion, browser, appVersion, userAgent)
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
	// DeviceInfo is the optional platform/browser metadata for the Devices list.
	DeviceInfo *DeviceInfo `json:"device_info"`
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
	// DeviceInfo is the platform/browser metadata reported at registration.
	// Omitted for devices that have never reported any.
	DeviceInfo *DeviceInfo `json:"device_info,omitempty"`
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

		dev, err := upsertDeviceForAccount(pool, r, req.DeviceID, req.PublicKey, encryptionKey, accountID, req.DeviceInfo)
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
			SELECT device_id, account_id, public_key, encryption_public_key, status, created_at, revoked_at, display_name, last_seen_at,
			       platform, os_version, browser, app_version, user_agent
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
			var (
				dev        DeviceResponse
				platform   *string
				osVersion  *string
				browser    *string
				appVersion *string
				userAgent  *string
			)
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
				&platform,
				&osVersion,
				&browser,
				&appVersion,
				&userAgent,
			); err != nil {
				respondError(w, http.StatusInternalServerError, "failed to scan device")
				return
			}
			dev.DeviceInfo = deviceInfoFromColumns(platform, osVersion, browser, appVersion, userAgent)
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
		//
		// `recipient_id` is drawn from globally-unique namespaces (devices and
		// storage_nodes are both primary keys), so the bare `recipient_id = $1`
		// predicate cannot reach another tenant's rows today. The EXISTS guard
		// re-asserts account ownership locally so that invariant no longer has to
		// hold across three tables for this delete to be safe — and it keeps
		// `recipient_id` as the leading predicate, preserving migration 017's
		// idx_folder_key_envelopes_recipient.
		_, _ = pool.Exec(r.Context(), `
			DELETE FROM key_envelopes
			WHERE recipient_id = $1
			  AND EXISTS (SELECT 1 FROM devices d WHERE d.device_id = $1 AND d.account_id = $2)
		`, deviceID, accountID)
		_, _ = pool.Exec(r.Context(), `
			DELETE FROM folder_key_envelopes
			WHERE recipient_id = $1
			  AND EXISTS (SELECT 1 FROM devices d WHERE d.device_id = $1 AND d.account_id = $2)
		`, deviceID, accountID)

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
