package auth

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/TalibMushtaq/nodus/services/relay/internal/config"
)

// AuthenticateRequest resolves either the session cookie or an opaque bearer
// token. Native clients use the bearer form; browsers remain cookie-only.
func AuthenticateRequest(r *http.Request, store SessionStore, cfg *config.Config) (*Session, string, error) {
	var candidates []string
	if cookie, err := r.Cookie(cfg.SessionCookieName); err == nil {
		if cookie.Value != "" {
			candidates = append(candidates, cookie.Value)
		}
	}
	if header := r.Header.Get("Authorization"); strings.HasPrefix(header, "Bearer ") {
		if bearer := strings.TrimSpace(strings.TrimPrefix(header, "Bearer ")); bearer != "" {
			candidates = append(candidates, bearer)
		}
	}
	if len(candidates) == 0 {
		return nil, "", ErrSessionInvalid
	}
	var lastErr error
	for _, raw := range candidates {
		sess, err := store.LookupSession(r.Context(), raw)
		if err == nil && sess != nil {
			return sess, raw, nil
		}
		lastErr = err
	}
	if lastErr == nil {
		lastErr = ErrSessionInvalid
	}
	return nil, "", lastErr
}

type contextKey string

const (
	AccountIDKey contextKey = "account_id"
	DeviceIDKey  contextKey = "device_id"
	SessionKey   contextKey = "session"
)

// RequireAuth guards routes with the session cookie (nodus_session by default):
// it hashes the raw cookie value, looks the session up in PostgreSQL, and on
// success populates the request context with AccountID, DeviceID and the
// resolved Session. Any missing/expired/revoked/bad session yields 401.
func RequireAuth(store SessionStore, cfg *config.Config) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			sess, raw, err := AuthenticateRequest(r, store, cfg)
			if err != nil {
				if errors.Is(err, ErrSessionInvalid) {
					http.Error(w, `{"error":"invalid or expired session"}`, http.StatusUnauthorized)
					return
				}
				http.Error(w, `{"error":"session lookup failed"}`, http.StatusInternalServerError)
				return
			}
			if sess == nil {
				http.Error(w, `{"error":"invalid or expired session"}`, http.StatusUnauthorized)
				return
			}

			// last_used_at bump best-effort; failures must not fail the request,
			// and the store throttles it to at most once per 30 minutes anyway.
			_ = store.TouchSession(r.Context(), raw)

			ctx := context.WithValue(r.Context(), AccountIDKey, sess.AccountID)
			ctx = context.WithValue(ctx, DeviceIDKey, sess.DeviceID)
			ctx = context.WithValue(ctx, SessionKey, sess)

			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// GetAccountID extracts the authenticated account ID from the request context.
func GetAccountID(ctx context.Context) (string, bool) {
	val := ctx.Value(AccountIDKey)
	if val == nil {
		return "", false
	}
	id, ok := val.(string)
	return id, ok
}

// GetDeviceID extracts the device ID bound to the authenticated session.
func GetDeviceID(ctx context.Context) (string, bool) {
	val := ctx.Value(DeviceIDKey)
	if val == nil {
		return "", false
	}
	id, ok := val.(string)
	return id, ok
}

// GetSession extracts the resolved session from the request context.
func GetSession(ctx context.Context) (*Session, bool) {
	val := ctx.Value(SessionKey)
	if val == nil {
		return nil, false
	}
	sess, ok := val.(*Session)
	return sess, ok
}
