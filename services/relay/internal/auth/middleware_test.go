package auth_test

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/TalibMushtaq/nodus/services/relay/internal/auth"
	"github.com/TalibMushtaq/nodus/services/relay/internal/config"
)

func TestRequireAuthMiddleware(t *testing.T) {
	cfg := &config.Config{
		JWTSecret: "test-secret-key-1234567890",
		JWTExpiry: 15 * time.Minute,
	}

	accountID := "acc-middleware-test"
	token, _, err := auth.IssueAccessToken(cfg, accountID)
	if err != nil {
		t.Fatalf("failed to issue token: %v", err)
	}

	protectedHandler := auth.RequireAuth(cfg)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id, ok := auth.GetAccountID(r.Context())
		if !ok || id != accountID {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	}))

	// Case 1: Valid token
	req := httptest.NewRequest("GET", "/protected", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	protectedHandler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status 200 with valid token, got %d", rec.Code)
	}

	// Case 2: Missing header
	reqNoAuth := httptest.NewRequest("GET", "/protected", nil)
	recNoAuth := httptest.NewRecorder()
	protectedHandler.ServeHTTP(recNoAuth, reqNoAuth)

	if recNoAuth.Code != http.StatusUnauthorized {
		t.Fatalf("expected status 401 with missing auth, got %d", recNoAuth.Code)
	}

	// Case 3: Malformed header
	reqBadAuth := httptest.NewRequest("GET", "/protected", nil)
	reqBadAuth.Header.Set("Authorization", "Basic 12345")
	recBadAuth := httptest.NewRecorder()
	protectedHandler.ServeHTTP(recBadAuth, reqBadAuth)

	if recBadAuth.Code != http.StatusUnauthorized {
		t.Fatalf("expected status 401 with bad auth prefix, got %d", recBadAuth.Code)
	}
}
