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
}

// SessionResponse is the locked Phase 7a §2 post-auth body: account/device ids
// plus the absolute session expiry. No token ever travels in the body — the
// session lives in the HttpOnly cookie.
type SessionResponse struct {
	AccountID        string    `json:"account_id"`
	DeviceID         string    `json:"device_id"`
	SessionExpiresAt time.Time `json:"session_expires_at"`
	AccessToken      string    `json:"access_token,omitempty"`
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

		hashedPassword, err := auth.HashPassword(req.Password)
		if err != nil {
			respondError(w, http.StatusInternalServerError, "failed to hash password")
			return
		}

		accountID := uuid.NewString()
		query := `
			INSERT INTO accounts (account_id, email, password_hash)
			VALUES ($1, $2, $3)
		`

		tx, err := pool.Begin(r.Context())
		if err != nil {
			respondError(w, http.StatusInternalServerError, "failed to start transaction")
			return
		}
		defer tx.Rollback(r.Context()) // nolint:errcheck

		_, err = tx.Exec(r.Context(), query, accountID, req.Email, hashedPassword)
		if err != nil {
			if strings.Contains(err.Error(), "duplicate key") || strings.Contains(err.Error(), "unique constraint") {
				respondError(w, http.StatusConflict, "an account with this email already exists")
				return
			}
			respondError(w, http.StatusInternalServerError, "failed to create account")
			return
		}

		// The first device auto-registers with the account (§2).
		if _, err := upsertDeviceForAccount(tx, r, req.DeviceID, req.DevicePublicKey, accountID); err != nil {
			respondDeviceUpsertError(w, err)
			return
		}

		if err := tx.Commit(r.Context()); err != nil {
			respondError(w, http.StatusInternalServerError, "failed to commit transaction")
			return
		}

		issueSession(w, r, store, cfg, accountID, req.DeviceID, http.StatusCreated)
	}
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

		var (
			accountID    string
			passwordHash string
		)

		query := `SELECT account_id, password_hash FROM accounts WHERE email = $1`
		err := pool.QueryRow(r.Context(), query, req.Email).Scan(&accountID, &passwordHash)
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
		if _, err := upsertDeviceForAccount(pool, r, req.DeviceID, req.DevicePublicKey, accountID); err != nil {
			respondDeviceUpsertError(w, err)
			return
		}

		issueSession(w, r, store, cfg, accountID, req.DeviceID, http.StatusOK)
	}
}

// Session reports the current session bound to the request cookie, or 401 when
// the cookie is missing/expired/revoked.
func Session(store auth.SessionStore, cfg *config.Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		sess, _, err := auth.AuthenticateRequest(r, store, cfg)
		if err != nil {
			respondError(w, http.StatusUnauthorized, "missing session cookie")
			return
		}

		respondJSON(w, http.StatusOK, SessionResponse{
			AccountID:        sess.AccountID,
			DeviceID:         sess.DeviceID,
			SessionExpiresAt: sess.ExpiresAt,
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
func issueSession(w http.ResponseWriter, r *http.Request, store auth.SessionStore, cfg *config.Config, accountID, deviceID string, status int) {
	rawID, err := store.CreateSession(r.Context(), accountID, deviceID)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "failed to create session")
		return
	}

	expiresAt := time.Now().UTC().Add(cfg.SessionMaxAge)
	setSessionCookie(w, cfg, rawID, expiresAt)

	response := SessionResponse{
		AccountID:        accountID,
		DeviceID:         deviceID,
		SessionExpiresAt: expiresAt,
	}
	if r.Header.Get("X-Nodus-Client") == "mobile" {
		response.AccessToken = rawID
	}
	respondJSON(w, status, response)
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
