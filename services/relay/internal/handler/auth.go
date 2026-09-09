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

type RegisterRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
	DeviceID string `json:"device_id"`
}

// SessionResponse is the post-JWT login/register body: the old AuthResponse
// shape minus access/refresh tokens. Phase 7a §2 replaces it with the locked
// {account_id, device_id, session_expires_at} shape plus device auto-registration.
type SessionResponse struct {
	AccountID string    `json:"account_id"`
	DeviceID  string    `json:"device_id"`
	ExpiresAt time.Time `json:"expires_at"`
	ExpiresIn int64     `json:"expires_in"` // in seconds
}

// Register creates a new user account. It does not mint a session: a session
// cannot exist without a registered, ACTIVE device (sessions.device_id is NOT
// NULL, plan §13), and a fresh account owns none yet. The client registers a
// device via POST /devices/register, then logs in to obtain the session cookie;
// §2 makes device registration automatic.
func Register(pool *db.Pool, cfg *config.Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req RegisterRequest
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

		if req.DeviceID == "" {
			respondError(w, http.StatusBadRequest, "device_id is required")
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

		_, err = pool.Exec(r.Context(), query, accountID, req.Email, hashedPassword)
		if err != nil {
			if strings.Contains(err.Error(), "duplicate key") || strings.Contains(err.Error(), "unique constraint") {
				respondError(w, http.StatusConflict, "an account with this email already exists")
				return
			}
			respondError(w, http.StatusInternalServerError, "failed to create account")
			return
		}

		// A fresh account owns no device yet, so no device-bound session can be
		// issued here (sessions.device_id is NOT NULL). The client registers the
		// device via POST /devices/register, then logs in to mint the session;
		// §2 wires auto-registration directly beside session creation.
		respondJSON(w, http.StatusCreated, SessionResponse{
			AccountID: accountID,
			DeviceID:  req.DeviceID,
		})
	}
}

// Login authenticates a user by email and password, then mints a session cookie
// bound to the supplied device.
func Login(pool *db.Pool, store auth.SessionStore, cfg *config.Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req RegisterRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			respondError(w, http.StatusBadRequest, "invalid request body")
			return
		}

		req.Email = strings.TrimSpace(strings.ToLower(req.Email))
		if req.Email == "" || req.Password == "" || req.DeviceID == "" {
			respondError(w, http.StatusBadRequest, "email, password and device_id are required")
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

		// Sessions are device-bound; the device must exist and belong to this
		// account, otherwise a session row could not satisfy the FK nor pass
		// the ACTIVE check in LookupSession.
		if !deviceExistsForAccount(r, pool, req.DeviceID, accountID) {
			respondError(w, http.StatusUnauthorized, "device_id is not registered to this account")
			return
		}

		issueSession(w, r, store, cfg, accountID, req.DeviceID)
	}
}

// Session reports the current session bound to the request cookie, or 401 when
// the cookie is missing/expired/revoked.
func Session(store auth.SessionStore, cfg *config.Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cookie, err := r.Cookie(cfg.SessionCookieName)
		if err != nil || cookie.Value == "" {
			respondError(w, http.StatusUnauthorized, "missing session cookie")
			return
		}

		sess, err := store.LookupSession(r.Context(), cookie.Value)
		if err != nil {
			respondError(w, http.StatusUnauthorized, "invalid or expired session")
			return
		}

		respondJSON(w, http.StatusOK, SessionResponse{
			AccountID: sess.AccountID,
			DeviceID:  sess.DeviceID,
			ExpiresAt: sess.ExpiresAt,
			ExpiresIn: int64(time.Until(sess.ExpiresAt).Seconds()),
		})
	}
}

// Logout revokes the session row behind the cookie and clears the cookie. It is
// deliberately not gated behind RequireAuth so an expired/revoked cookie can
// still be cleared client-side.
func Logout(store auth.SessionStore, cfg *config.Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cookie, err := r.Cookie(cfg.SessionCookieName)
		if err == nil && cookie.Value != "" {
			_ = store.RevokeSession(r.Context(), cookie.Value)
		}
		clearSessionCookie(w, cfg)
		respondJSON(w, http.StatusOK, map[string]string{"status": "logged out"})
	}
}

// deviceExistsForAccount reports whether the device is registered to the
// account and ACTIVE (device identity owns asymmetric keys; sessions must bind
// to one of them).
func deviceExistsForAccount(r *http.Request, pool *db.Pool, deviceID, accountID string) bool {
	var exists bool
	err := pool.QueryRow(r.Context(),
		`SELECT EXISTS(SELECT 1 FROM devices WHERE device_id = $1 AND account_id = $2 AND status = 'ACTIVE')`,
		deviceID, accountID,
	).Scan(&exists)
	return err == nil && exists
}

// issueSession mints a session, writes the HttpOnly cookie, and responds.
func issueSession(w http.ResponseWriter, r *http.Request, store auth.SessionStore, cfg *config.Config, accountID, deviceID string) {
	rawID, err := store.CreateSession(r.Context(), accountID, deviceID)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "failed to create session")
		return
	}
	setSessionCookie(w, cfg, rawID, time.Now().UTC().Add(cfg.SessionMaxAge))

	sess, _ := store.LookupSession(r.Context(), rawID)
	expiresAt := time.Now().UTC().Add(cfg.SessionMaxAge)
	expiresIn := int64(cfg.SessionMaxAge.Seconds())
	if sess != nil {
		expiresAt = sess.ExpiresAt
		expiresIn = int64(time.Until(sess.ExpiresAt).Seconds())
	}

	respondJSON(w, http.StatusCreated, SessionResponse{
		AccountID: accountID,
		DeviceID:  deviceID,
		ExpiresAt: expiresAt,
		ExpiresIn: expiresIn,
	})
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
