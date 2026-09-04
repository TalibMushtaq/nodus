package auth

import (
	"context"
	"net/http"
	"strings"

	"github.com/TalibMushtaq/nodus/services/relay/internal/config"
)

type contextKey string

const (
	AccountIDKey contextKey = "account_id"
	ClaimsKey    contextKey = "jwt_claims"
)

// RequireAuth creates an HTTP middleware verifying the Authorization: Bearer <token> header.
func RequireAuth(cfg *config.Config) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			authHeader := r.Header.Get("Authorization")
			if authHeader == "" {
				http.Error(w, `{"error":"missing Authorization header"}`, http.StatusUnauthorized)
				return
			}

			parts := strings.SplitN(authHeader, " ", 2)
			if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
				http.Error(w, `{"error":"invalid Authorization header format, expected Bearer <token>"}`, http.StatusUnauthorized)
				return
			}

			claims, err := ParseAccessToken(cfg, parts[1])
			if err != nil {
				http.Error(w, `{"error":"invalid or expired token"}`, http.StatusUnauthorized)
				return
			}

			ctx := context.WithValue(r.Context(), AccountIDKey, claims.AccountID)
			ctx = context.WithValue(ctx, ClaimsKey, claims)

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
