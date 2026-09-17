package handler

import (
	"encoding/json"
	"net/http"

	"github.com/TalibMushtaq/nodus/services/relay/internal/auth"
	"github.com/TalibMushtaq/nodus/services/relay/internal/db"
)

// pushPrefsRequest mirrors the client's notification toggles. Every field is a
// pointer so an omitted value means "leave unchanged" rather than "false".
type pushPrefsRequest struct {
	Conflicts     *bool `json:"conflicts"`
	DeviceOffline *bool `json:"device_offline"`
	SyncComplete  *bool `json:"sync_complete"`
}

// pushTokenRequest registers or refreshes this device's Expo push token.
type pushTokenRequest struct {
	Token    string            `json:"token"`
	Platform string            `json:"platform"`
	Prefs    *pushPrefsRequest `json:"prefs"`
}

// RegisterPushToken upserts the calling device's push token and preferences.
// Ownership comes from the authenticated session, so a device can only ever
// register its own token (never another device's).
func RegisterPushToken(pool *db.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		accountID, ok := auth.GetAccountID(r.Context())
		if !ok {
			respondError(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		deviceID, ok := auth.GetDeviceID(r.Context())
		if !ok {
			respondError(w, http.StatusUnauthorized, "unauthorized")
			return
		}

		var req pushTokenRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			respondError(w, http.StatusBadRequest, "invalid body")
			return
		}
		if req.Token == "" {
			respondError(w, http.StatusBadRequest, "missing token")
			return
		}
		platform := req.Platform
		if platform == "" {
			platform = "unknown"
		}

		var conflicts, deviceOffline, syncComplete *bool
		if req.Prefs != nil {
			conflicts = req.Prefs.Conflicts
			deviceOffline = req.Prefs.DeviceOffline
			syncComplete = req.Prefs.SyncComplete
		}

		if _, err := pool.Exec(r.Context(), `
			INSERT INTO push_tokens (
				device_id, account_id, token, platform,
				notify_conflicts, notify_device_offline, notify_sync_complete, updated_at
			)
			VALUES ($1, $2, $3, $4, COALESCE($5, TRUE), COALESCE($6, TRUE), COALESCE($7, TRUE), NOW())
			ON CONFLICT (device_id) DO UPDATE SET
				account_id = EXCLUDED.account_id,
				token = EXCLUDED.token,
				platform = EXCLUDED.platform,
				notify_conflicts = COALESCE($5, push_tokens.notify_conflicts),
				notify_device_offline = COALESCE($6, push_tokens.notify_device_offline),
				notify_sync_complete = COALESCE($7, push_tokens.notify_sync_complete),
				updated_at = NOW()
		`, deviceID, accountID, req.Token, platform, conflicts, deviceOffline, syncComplete); err != nil {
			respondError(w, http.StatusInternalServerError, "failed to register token")
			return
		}

		respondJSON(w, http.StatusOK, map[string]any{"status": "ok"})
	}
}

// DeletePushToken removes this device's token (called on sign-out).
func DeletePushToken(pool *db.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		accountID, ok := auth.GetAccountID(r.Context())
		if !ok {
			respondError(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		deviceID, ok := auth.GetDeviceID(r.Context())
		if !ok {
			respondError(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		if _, err := pool.Exec(r.Context(),
			`DELETE FROM push_tokens WHERE device_id = $1 AND account_id = $2`,
			deviceID, accountID); err != nil {
			respondError(w, http.StatusInternalServerError, "failed to remove token")
			return
		}
		respondJSON(w, http.StatusOK, map[string]any{"status": "ok"})
	}
}

// webPushKeys are the browser PushSubscription keys.
type webPushKeys struct {
	P256dh string `json:"p256dh"`
	Auth   string `json:"auth"`
}

// webPushRequest registers or removes a browser PushSubscription.
type webPushRequest struct {
	Endpoint string            `json:"endpoint"`
	Keys     *webPushKeys      `json:"keys"`
	Prefs    *pushPrefsRequest `json:"prefs"`
}

// RegisterWebPush upserts a browser push subscription for the account. Unlike
// the Expo token, a subscription is keyed by endpoint (a browser profile), so
// several accounts could share a browser; the endpoint row is re-pointed on
// each registration.
func RegisterWebPush(pool *db.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		accountID, ok := auth.GetAccountID(r.Context())
		if !ok {
			respondError(w, http.StatusUnauthorized, "unauthorized")
			return
		}

		var req webPushRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			respondError(w, http.StatusBadRequest, "invalid body")
			return
		}
		if req.Endpoint == "" || req.Keys == nil || req.Keys.P256dh == "" || req.Keys.Auth == "" {
			respondError(w, http.StatusBadRequest, "missing endpoint or keys")
			return
		}

		var conflicts, deviceOffline, syncComplete *bool
		if req.Prefs != nil {
			conflicts = req.Prefs.Conflicts
			deviceOffline = req.Prefs.DeviceOffline
			syncComplete = req.Prefs.SyncComplete
		}

		if _, err := pool.Exec(r.Context(), `
			INSERT INTO web_push_subscriptions (
				endpoint, account_id, p256dh, auth,
				notify_conflicts, notify_device_offline, notify_sync_complete, updated_at
			)
			VALUES ($1, $2, $3, $4, COALESCE($5, TRUE), COALESCE($6, TRUE), COALESCE($7, TRUE), NOW())
			ON CONFLICT (endpoint) DO UPDATE SET
				account_id = EXCLUDED.account_id,
				p256dh = EXCLUDED.p256dh,
				auth = EXCLUDED.auth,
				notify_conflicts = COALESCE($5, web_push_subscriptions.notify_conflicts),
				notify_device_offline = COALESCE($6, web_push_subscriptions.notify_device_offline),
				notify_sync_complete = COALESCE($7, web_push_subscriptions.notify_sync_complete),
				updated_at = NOW()
		`, req.Endpoint, accountID, req.Keys.P256dh, req.Keys.Auth, conflicts, deviceOffline, syncComplete); err != nil {
			respondError(w, http.StatusInternalServerError, "failed to register subscription")
			return
		}
		respondJSON(w, http.StatusOK, map[string]any{"status": "ok"})
	}
}

// DeleteWebPush removes a browser push subscription owned by the account.
func DeleteWebPush(pool *db.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		accountID, ok := auth.GetAccountID(r.Context())
		if !ok {
			respondError(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		var req webPushRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Endpoint == "" {
			respondError(w, http.StatusBadRequest, "missing endpoint")
			return
		}
		if _, err := pool.Exec(r.Context(),
			`DELETE FROM web_push_subscriptions WHERE endpoint = $1 AND account_id = $2`,
			req.Endpoint, accountID); err != nil {
			respondError(w, http.StatusInternalServerError, "failed to remove subscription")
			return
		}
		respondJSON(w, http.StatusOK, map[string]any{"status": "ok"})
	}
}
