package handler

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/TalibMushtaq/nodus/services/relay/internal/auth"
	"github.com/TalibMushtaq/nodus/services/relay/internal/config"
	"github.com/TalibMushtaq/nodus/services/relay/internal/db"
	"github.com/google/uuid"
)

// AuthRequest is the shared login/register body. device_id + device_public_key
// are required (§2): the client generates the device keypair up front and the
// relay auto-registers the device beside session creation.
type AuthRequest struct {
	Email           string `json:"email"`
	Password        string `json:"password"`
	DeviceID        string `json:"device_id"`
	DevicePublicKey string `json:"device_public_key"`
	// DeviceEncryptionPublicKey is the device's X25519 key (base64, ADR-0008).
	// Optional; when absent the device keeps any previously published key.
	DeviceEncryptionPublicKey string `json:"device_encryption_public_key"`
	// RecoveryPublicKey is the Ed25519 key derived from the user's offline
	// recovery phrase. Sent on register (to enroll recovery); ignored on login,
	// which must never overwrite an existing recovery key. Optional so older
	// clients and tests keep working — an account without one cannot be
	// recovered until a trusted device enrolls it.
	RecoveryPublicKey string `json:"recovery_public_key"`
}

// ChangePasswordRequest is the authenticated credential-change body. Both
// fields are required: the current password is re-verified before the hash is
// replaced so a stolen session cookie alone cannot take over the account.
type ChangePasswordRequest struct {
	CurrentPassword string `json:"current_password"`
	NewPassword     string `json:"new_password"`
}

// SessionResponse is the locked Phase 7a §2 post-auth body: account/device ids
// plus the absolute session expiry. No token ever travels in the body — the
// session lives in the HttpOnly cookie.
type SessionResponse struct {
	AccountID        string    `json:"account_id"`
	DeviceID         string    `json:"device_id"`
	SessionExpiresAt time.Time `json:"session_expires_at"`
	AccessToken      string    `json:"access_token,omitempty"`
	// RecoveryPublicKey lets the client seal file/folder keys to the account's
	// recovery identity. Nil when recovery is not enrolled.
	RecoveryPublicKey *string `json:"recovery_public_key,omitempty"`
}

// Register creates a new user account, auto-registers its first device, and
// mints the session cookie so one call leaves the client authenticated.
func Register(pool *db.Pool, store auth.SessionStore, cfg *config.Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		r.Body = http.MaxBytesReader(w, r.Body, 16<<10)
		var req AuthRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			respondError(w, http.StatusBadRequest, "invalid request body")
			return
		}

		req.Email = strings.TrimSpace(strings.ToLower(req.Email))
		if req.Email == "" || !strings.Contains(req.Email, "@") {
			respondError(w, http.StatusBadRequest, "valid email is required")
			return
		}

		if len(req.Password) < 8 {
			respondError(w, http.StatusBadRequest, "password must be at least 8 characters")
			return
		}

		if req.DeviceID == "" || req.DevicePublicKey == "" {
			respondError(w, http.StatusBadRequest, "device_id and device_public_key are required")
			return
		}

		encryptionKey, valid := normalizeEncryptionPublicKey(req.DeviceEncryptionPublicKey)
		if !valid {
			respondError(w, http.StatusBadRequest, "device_encryption_public_key must be a 32-byte base64 X25519 public key")
			return
		}

		hashedPassword, err := auth.HashPassword(req.Password)
		if err != nil {
			respondError(w, http.StatusInternalServerError, "failed to hash password")
			return
		}

		accountID := uuid.NewString()
		// nullif turns an omitted recovery key into NULL rather than an empty
		// string, so "enrolled?" stays a single nil check.
		query := `
			INSERT INTO accounts (account_id, email, password_hash, recovery_public_key)
			VALUES ($1, $2, $3, nullif($4, ''))
		`

		tx, err := pool.Begin(r.Context())
		if err != nil {
			respondError(w, http.StatusInternalServerError, "failed to start transaction")
			return
		}
		defer tx.Rollback(r.Context()) // nolint:errcheck

		_, err = tx.Exec(r.Context(), query, accountID, req.Email, hashedPassword, req.RecoveryPublicKey)
		if err != nil {
			if strings.Contains(err.Error(), "duplicate key") || strings.Contains(err.Error(), "unique constraint") {
				respondError(w, http.StatusConflict, "an account with this email already exists")
				return
			}
			respondError(w, http.StatusInternalServerError, "failed to create account")
			return
		}

		// The first device auto-registers with the account (§2).
		if _, err := upsertDeviceForAccount(tx, r, req.DeviceID, req.DevicePublicKey, encryptionKey, accountID); err != nil {
			respondDeviceUpsertError(w, err)
			return
		}

		if err := tx.Commit(r.Context()); err != nil {
			respondError(w, http.StatusInternalServerError, "failed to commit transaction")
			return
		}

		issueSession(w, r, store, cfg, accountID, req.DeviceID, recoveryKeyPtr(req.RecoveryPublicKey), http.StatusCreated)
	}
}

// recoveryKeyPtr returns a pointer to a non-empty key, else nil, so an omitted
// recovery key serializes as absent rather than "".
func recoveryKeyPtr(key string) *string {
	if key == "" {
		return nil
	}
	return &key
}

// Login authenticates a user by email and password, auto-registers the device
// on first use (§2), then mints a session cookie bound to that device.
func Login(pool *db.Pool, store auth.SessionStore, cfg *config.Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		r.Body = http.MaxBytesReader(w, r.Body, 16<<10)
		var req AuthRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			respondError(w, http.StatusBadRequest, "invalid request body")
			return
		}

		req.Email = strings.TrimSpace(strings.ToLower(req.Email))
		if req.Email == "" || req.Password == "" || req.DeviceID == "" || req.DevicePublicKey == "" {
			respondError(w, http.StatusBadRequest, "email, password, device_id and device_public_key are required")
			return
		}

		encryptionKey, valid := normalizeEncryptionPublicKey(req.DeviceEncryptionPublicKey)
		if !valid {
			respondError(w, http.StatusBadRequest, "device_encryption_public_key must be a 32-byte base64 X25519 public key")
			return
		}

		var (
			accountID         string
			passwordHash      string
			recoveryPublicKey *string
		)

		query := `SELECT account_id, password_hash, recovery_public_key FROM accounts WHERE email = $1`
		err := pool.QueryRow(r.Context(), query, req.Email).Scan(&accountID, &passwordHash, &recoveryPublicKey)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				respondError(w, http.StatusUnauthorized, "invalid email or password")
				return
			}
			respondError(w, http.StatusInternalServerError, "database error")
			return
		}

		ok, err := auth.VerifyPassword(passwordHash, req.Password)
		if err != nil || !ok {
			respondError(w, http.StatusUnauthorized, "invalid email or password")
			return
		}

		// Device auto-registration replaces the old pre-registration gate: the
		// supplied device_id/public_key is upserted for THIS account (ownership
		// guarded), so first login from a new device needs no separate
		// /devices/register call.
		if _, err := upsertDeviceForAccount(pool, r, req.DeviceID, req.DevicePublicKey, encryptionKey, accountID); err != nil {
			respondDeviceUpsertError(w, err)
			return
		}

		issueSession(w, r, store, cfg, accountID, req.DeviceID, recoveryPublicKey, http.StatusOK)
	}
}

// Session reports the current session bound to the request cookie, or 401 when
// the cookie is missing/expired/revoked. It also returns whether the account has
// enrolled a recovery key so the client knows whether uploads should seal to it.
func Session(pool *db.Pool, store auth.SessionStore, cfg *config.Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		sess, _, err := auth.AuthenticateRequest(r, store, cfg)
		if err != nil {
			respondError(w, http.StatusUnauthorized, "missing session cookie")
			return
		}

		var recoveryPublicKey *string
		_ = pool.QueryRow(r.Context(),
			"SELECT recovery_public_key FROM accounts WHERE account_id = $1", sess.AccountID,
		).Scan(&recoveryPublicKey)

		respondJSON(w, http.StatusOK, SessionResponse{
			AccountID:         sess.AccountID,
			DeviceID:          sess.DeviceID,
			SessionExpiresAt:  sess.ExpiresAt,
			RecoveryPublicKey: recoveryPublicKey,
		})
	}
}

// Logout revokes the session row behind the cookie and clears the cookie. It is
// deliberately not gated behind RequireAuth so an expired/revoked cookie can
// still be cleared client-side.
func Logout(store auth.SessionStore, cfg *config.Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if sess, raw, err := auth.AuthenticateRequest(r, store, cfg); err == nil && sess != nil {
			_ = store.RevokeSession(r.Context(), raw)
		} else if header := r.Header.Get("Authorization"); strings.HasPrefix(header, "Bearer ") {
			_ = store.RevokeSession(r.Context(), strings.TrimSpace(strings.TrimPrefix(header, "Bearer ")))
		}
		clearSessionCookie(w, cfg)
		respondJSON(w, http.StatusOK, map[string]string{"status": "logged out"})
	}
}

// issueSession mints a session, writes the HttpOnly cookie, and responds with
// the §2 body. status distinguishes register (201) from login (200).
func issueSession(w http.ResponseWriter, r *http.Request, store auth.SessionStore, cfg *config.Config, accountID, deviceID string, recoveryPublicKey *string, status int) {
	rawID, err := store.CreateSession(r.Context(), accountID, deviceID)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "failed to create session")
		return
	}
	writeSession(w, r, cfg, rawID, accountID, deviceID, recoveryPublicKey, status)
}

// writeSession sets the session cookie and emits the §2 body for an
// already-minted raw token. Shared by issueSession, ChangePassword (rotation)
// and LogoutAll (revoke-all + re-issue) so every path sets the same cookie
// flags and returns the same shape. The raw token is exposed in the body only
// for the mobile client (`X-Nodus-Client: mobile`), which holds it in secure
// storage instead of a cookie.
func writeSession(w http.ResponseWriter, r *http.Request, cfg *config.Config, rawID, accountID, deviceID string, recoveryPublicKey *string, status int) {
	expiresAt := time.Now().UTC().Add(cfg.SessionMaxAge)
	setSessionCookie(w, cfg, rawID, expiresAt)

	response := SessionResponse{
		AccountID:         accountID,
		DeviceID:          deviceID,
		SessionExpiresAt:  expiresAt,
		RecoveryPublicKey: recoveryPublicKey,
	}
	if r.Header.Get("X-Nodus-Client") == "mobile" {
		response.AccessToken = rawID
	}
	respondJSON(w, status, response)
}

// ChangePassword re-verifies the caller's current password, replaces the stored
// Argon2id hash, and rotates the session (new row, old revoked) in the same
// request. Rotation is the session-fixation defense from plan §13: a credential
// change must not leave the pre-change session identifier valid.
func ChangePassword(pool *db.Pool, store auth.SessionStore, cfg *config.Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		r.Body = http.MaxBytesReader(w, r.Body, 16<<10)
		accountID, ok := auth.GetAccountID(r.Context())
		if !ok {
			respondError(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		deviceID, _ := auth.GetDeviceID(r.Context())

		var req ChangePasswordRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			respondError(w, http.StatusBadRequest, "invalid request body")
			return
		}
		if req.CurrentPassword == "" || req.NewPassword == "" {
			respondError(w, http.StatusBadRequest, "current_password and new_password are required")
			return
		}
		if len(req.NewPassword) < 8 {
			respondError(w, http.StatusBadRequest, "new password must be at least 8 characters")
			return
		}
		if req.NewPassword == req.CurrentPassword {
			respondError(w, http.StatusBadRequest, "new password must differ from the current password")
			return
		}

		var passwordHash string
		if err := pool.QueryRow(r.Context(),
			"SELECT password_hash FROM accounts WHERE account_id = $1", accountID,
		).Scan(&passwordHash); err != nil {
			respondError(w, http.StatusInternalServerError, "database error")
			return
		}
		if ok, err := auth.VerifyPassword(passwordHash, req.CurrentPassword); err != nil || !ok {
			respondError(w, http.StatusUnauthorized, "current password is incorrect")
			return
		}

		newHash, err := auth.HashPassword(req.NewPassword)
		if err != nil {
			respondError(w, http.StatusInternalServerError, "failed to hash password")
			return
		}
		if _, err := pool.Exec(r.Context(),
			"UPDATE accounts SET password_hash = $1 WHERE account_id = $2", newHash, accountID,
		); err != nil {
			respondError(w, http.StatusInternalServerError, "failed to update password")
			return
		}

		// Rotate last: the old cookie is invalidated and a fresh one issued. If
		// the caller's session vanished concurrently, the password change still
		// stands and we force a re-login rather than failing the request.
		raw := rawSessionToken(r, cfg)
		newRaw, err := store.RotateSession(r.Context(), raw, accountID, deviceID)
		if err != nil {
			clearSessionCookie(w, cfg)
			respondError(w, http.StatusUnauthorized, "session expired; sign in again")
			return
		}

		writeSession(w, r, cfg, newRaw, accountID, deviceID, lookupRecoveryKey(pool, r, accountID), http.StatusOK)
	}
}

// LogoutAll revokes every active session for the account (`RevokeAllForAccount`)
// then mints a fresh session for the calling device, so "sign out everywhere"
// logs other devices out without kicking the current user out. Device identity is
// preserved (§8): only sessions are invalidated, never the devices themselves.
func LogoutAll(pool *db.Pool, store auth.SessionStore, cfg *config.Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		accountID, ok := auth.GetAccountID(r.Context())
		if !ok {
			respondError(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		deviceID, _ := auth.GetDeviceID(r.Context())

		if err := store.RevokeAllForAccount(r.Context(), accountID); err != nil {
			respondError(w, http.StatusInternalServerError, "failed to revoke sessions")
			return
		}

		rawID, err := store.CreateSession(r.Context(), accountID, deviceID)
		if err != nil {
			// Every session (including this one) is now revoked; a 401 with a
			// cleared cookie is the correct recovery.
			clearSessionCookie(w, cfg)
			respondError(w, http.StatusUnauthorized, "sessions revoked; sign in again")
			return
		}

		writeSession(w, r, cfg, rawID, accountID, deviceID, lookupRecoveryKey(pool, r, accountID), http.StatusOK)
	}
}

// rawSessionToken extracts the opaque session token from the cookie, falling
// back to a mobile Bearer header. Used by rotation, which needs the raw value
// that the request context (account/device ids only) does not carry.
func rawSessionToken(r *http.Request, cfg *config.Config) string {
	if cookie, err := r.Cookie(cfg.SessionCookieName); err == nil && cookie.Value != "" {
		return cookie.Value
	}
	if header := r.Header.Get("Authorization"); strings.HasPrefix(header, "Bearer ") {
		return strings.TrimSpace(strings.TrimPrefix(header, "Bearer "))
	}
	return ""
}

// lookupRecoveryKey reads the account's enrolled recovery public key, returning
// nil on absence or error so an optional field never fails the response.
func lookupRecoveryKey(pool *db.Pool, r *http.Request, accountID string) *string {
	var key *string
	_ = pool.QueryRow(r.Context(),
		"SELECT recovery_public_key FROM accounts WHERE account_id = $1", accountID,
	).Scan(&key)
	return key
}

// setSessionCookie writes the session token as an HttpOnly; Secure; SameSite=Lax
// cookie. The Secure flag opts out only when SESSION_COOKIE_SECURE=false (local
// dev over plain HTTP).
func setSessionCookie(w http.ResponseWriter, cfg *config.Config, rawID string, expiresAt time.Time) {
	http.SetCookie(w, &http.Cookie{
		Name:     cfg.SessionCookieName,
		Value:    rawID,
		Path:     "/",
		Expires:  expiresAt,
		MaxAge:   int(cfg.SessionMaxAge.Seconds()),
		HttpOnly: true,
		Secure:   cfg.SessionCookieSecure,
		SameSite: http.SameSiteLaxMode,
	})
}

// clearSessionCookie removes the session cookie (Max-Age=-1, epoch expiry).
func clearSessionCookie(w http.ResponseWriter, cfg *config.Config) {
	http.SetCookie(w, &http.Cookie{
		Name:     cfg.SessionCookieName,
		Value:    "",
		Path:     "/",
		Expires:  time.Unix(0, 0),
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   cfg.SessionCookieSecure,
		SameSite: http.SameSiteLaxMode,
	})
}

func respondJSON(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(data)
}

func respondError(w http.ResponseWriter, status int, message string) {
	respondJSON(w, status, map[string]string{"error": message})
}
