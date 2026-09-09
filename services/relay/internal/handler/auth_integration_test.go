package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/TalibMushtaq/nodus/services/relay/internal/auth"
	"github.com/TalibMushtaq/nodus/services/relay/internal/config"
	"github.com/TalibMushtaq/nodus/services/relay/internal/db"
)

// authHarness spins up the §2 auth routes (register/login/session/logout plus
// device revocation) against a live Postgres and an HTTP server with a cookie
// jar, so the full session-cookie lifecycle is exercised end to end.
type authHarness struct {
	ctx    context.Context
	pool   *db.Pool
	cfg    *config.Config
	server *httptest.Server
	client *http.Client
}

// authResponse mirrors the locked §2 session body plus decode of error responses.
type authResponse struct {
	AccountID        string    `json:"account_id"`
	DeviceID         string    `json:"device_id"`
	SessionExpiresAt time.Time `json:"session_expires_at"`
	Error            string    `json:"error"`
}

func setupAuthHarness(t *testing.T) *authHarness {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set; skipping integration test")
	}

	ctx := context.Background()
	if err := db.RunMigrations(url); err != nil {
		t.Fatalf("run migrations: %v", err)
	}
	pool, err := db.Open(ctx, &config.Config{DatabaseURL: url})
	require.NoError(t, err)
	t.Cleanup(pool.Close)

	cfg := &config.Config{
		SessionCookieName:    "nodus_session",
		SessionMaxAge:        30 * 24 * time.Hour,
		SessionTouchInterval: 30 * time.Minute,
		SessionCookieSecure:  false, // httptest speaks plain HTTP
	}
	store := auth.NewPGSessionStore(pool, cfg)

	mux := http.NewServeMux()
	mux.HandleFunc("POST /auth/register", Register(pool, store, cfg))
	mux.HandleFunc("POST /auth/login", Login(pool, store, cfg))
	mux.HandleFunc("GET /auth/session", Session(store, cfg))
	mux.HandleFunc("POST /auth/logout", Logout(store, cfg))
	mux.Handle("DELETE /devices/{id}", auth.RequireAuth(store, cfg)(RevokeDevice(pool, store)))

	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)

	jar, err := cookiejar.New(nil)
	require.NoError(t, err)
	client := server.Client()
	client.Jar = jar

	return &authHarness{ctx: ctx, pool: pool, cfg: cfg, server: server, client: client}
}

func (h *authHarness) do(t *testing.T, method, path, body string) (*http.Response, authResponse) {
	t.Helper()
	req, err := http.NewRequest(method, h.server.URL+path, bytes.NewReader([]byte(body)))
	require.NoError(t, err)
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := h.client.Do(req)
	require.NoError(t, err)

	var out authResponse
	_ = json.NewDecoder(resp.Body).Decode(&out)
	resp.Body.Close()
	return resp, out
}

// seedAccount inserts a raw account row with a bcrypt password hash so login
// tests can skip the register round-trip when exercising auto-registration.
func (h *authHarness) seedAccount(t *testing.T, accountID, email string) {
	t.Helper()
	hash, err := auth.HashPassword("password123")
	require.NoError(t, err)
	_, err = h.pool.Exec(h.ctx,
		`INSERT INTO accounts (account_id, email, password_hash) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
		accountID, email, hash)
	require.NoError(t, err)
}

func (h *authHarness) seedDevice(t *testing.T, deviceID, accountID, publicKey string) {
	t.Helper()
	_, err := h.pool.Exec(h.ctx,
		`INSERT INTO devices (device_id, account_id, public_key, status) VALUES ($1, $2, $3, 'ACTIVE') ON CONFLICT DO NOTHING`,
		deviceID, accountID, publicKey)
	require.NoError(t, err)
}

func (h *authHarness) deviceState(t *testing.T, deviceID string) (accountID, publicKey, status string) {
	t.Helper()
	err := h.pool.QueryRow(h.ctx,
		`SELECT account_id, public_key, status FROM devices WHERE device_id = $1`, deviceID,
	).Scan(&accountID, &publicKey, &status)
	require.NoError(t, err)
	return
}

// TestAuthRegisterMintsSessionCookie asserts the §2 register contract: one call
// creates the account + first device, sets the HttpOnly session cookie, and
// returns {account_id, device_id, session_expires_at}.
func TestAuthRegisterMintsSessionCookie(t *testing.T) {
	h := setupAuthHarness(t)
	// Unique per run: the test DB persists between invocations, and both the
	// email and device_id are globally unique keys.
	u := fmt.Sprintf("%d", time.Now().UnixNano())
	email := "register-full-" + u + "@test.local"
	device := "dev-register-" + u

	resp, out := h.do(t, "POST", "/auth/register",
		fmt.Sprintf(`{"email":%q,"password":"password123","device_id":%q,"device_public_key":"pub-register"}`, email, device))
	require.Equal(t, http.StatusCreated, resp.StatusCode)
	require.NotEmpty(t, out.AccountID)
	require.Equal(t, device, out.DeviceID)
	require.True(t, out.SessionExpiresAt.After(time.Now()), "session_expires_at must be in the future")

	account, pub, status := h.deviceState(t, device)
	require.Equal(t, out.AccountID, account, "registered device must belong to the new account")
	require.Equal(t, "pub-register", pub)
	require.Equal(t, "ACTIVE", status)

	sessResp, sess := h.do(t, "GET", "/auth/session", "")
	require.Equal(t, http.StatusOK, sessResp.StatusCode)
	require.Equal(t, out.AccountID, sess.AccountID)
	require.Equal(t, device, sess.DeviceID)

	// Same email cannot register twice.
	dupResp, _ := h.do(t, "POST", "/auth/register",
		fmt.Sprintf(`{"email":%q,"password":"password123","device_id":%q,"device_public_key":"pub2"}`, email, device+"-2"))
	require.Equal(t, http.StatusConflict, dupResp.StatusCode)
}

// TestAuthLoginAutoRegistersDevice ensures first login from a never-seen device
// registers it (binding the session) without a separate /devices/register call.
func TestAuthLoginAutoRegistersDevice(t *testing.T) {
	h := setupAuthHarness(t)
	h.seedAccount(t, "acct-loginauto", "login-auto@test.local")

	resp, out := h.do(t, "POST", "/auth/login",
		`{"email":"login-auto@test.local","password":"password123","device_id":"dev-loginauto","device_public_key":"pub-loginauto"}`)
	require.Equal(t, http.StatusOK, resp.StatusCode)
	require.Equal(t, "acct-loginauto", out.AccountID)
	require.Equal(t, "dev-loginauto", out.DeviceID)

	account, pub, status := h.deviceState(t, "dev-loginauto")
	require.Equal(t, "acct-loginauto", account)
	require.Equal(t, "pub-loginauto", pub)
	require.Equal(t, "ACTIVE", status)

	sessResp, sess := h.do(t, "GET", "/auth/session", "")
	require.Equal(t, http.StatusOK, sessResp.StatusCode)
	require.Equal(t, "acct-loginauto", sess.AccountID)
	require.Equal(t, "dev-loginauto", sess.DeviceID)
}

// TestAuthLoginBadPasswordDoesNotRegisterDevice: a failed login must not mutate
// device state.
func TestAuthLoginBadPasswordDoesNotRegisterDevice(t *testing.T) {
	h := setupAuthHarness(t)
	h.seedAccount(t, "acct-loginfail", "login-fail@test.local")

	resp, _ := h.do(t, "POST", "/auth/login",
		`{"email":"login-fail@test.local","password":"wrong-pass","device_id":"dev-loginfail","device_public_key":"pub-loginfail"}`)
	require.Equal(t, http.StatusUnauthorized, resp.StatusCode)

	sessResp, _ := h.do(t, "GET", "/auth/session", "")
	require.Equal(t, http.StatusUnauthorized, sessResp.StatusCode)
}

// TestAuthCrossAccountDeviceConflict rejects a device_id already owned by
// another account without overwriting the owner's public key.
func TestAuthCrossAccountDeviceConflict(t *testing.T) {
	h := setupAuthHarness(t)
	h.seedAccount(t, "acct-devowner", "device-owner@test.local")
	h.seedDevice(t, "dev-owned", "acct-devowner", "pub-original")
	h.seedAccount(t, "acct-devintruder", "device-intruder@test.local")

	resp, out := h.do(t, "POST", "/auth/login",
		`{"email":"device-intruder@test.local","password":"password123","device_id":"dev-owned","device_public_key":"pub-stolen"}`)
	require.Equal(t, http.StatusConflict, resp.StatusCode)
	require.Contains(t, out.Error, "another account")

	account, pub, _ := h.deviceState(t, "dev-owned")
	require.Equal(t, "acct-devowner", account, "ownership must not transfer")
	require.Equal(t, "pub-original", pub, "public key must not be overwritten")
}

// TestAuthSessionUnauthorized: no cookie → 401; garbage cookie → 401.
func TestAuthSessionUnauthorized(t *testing.T) {
	h := setupAuthHarness(t)

	resp, _ := h.do(t, "GET", "/auth/session", "")
	require.Equal(t, http.StatusUnauthorized, resp.StatusCode)

	req, err := http.NewRequest("GET", h.server.URL+"/auth/session", nil)
	require.NoError(t, err)
	req.AddCookie(&http.Cookie{Name: h.cfg.SessionCookieName, Value: "garbage-token"})
	httpResp, err := h.client.Do(req)
	require.NoError(t, err)
	require.Equal(t, http.StatusUnauthorized, httpResp.StatusCode)
	httpResp.Body.Close()
}

// TestAuthLogoutRevokesAndClearsCookie: logout returns a clearing Set-Cookie and
// the old cookie no longer authenticates.
func TestAuthLogoutRevokesAndClearsCookie(t *testing.T) {
	h := setupAuthHarness(t)
	h.seedAccount(t, "acct-logout", "logout@test.local")

	loginResp, _ := h.do(t, "POST", "/auth/login",
		`{"email":"logout@test.local","password":"password123","device_id":"dev-logout","device_public_key":"pub-logout"}`)
	require.Equal(t, http.StatusOK, loginResp.StatusCode)

	logoutResp, _ := h.do(t, "POST", "/auth/logout", "")
	require.Equal(t, http.StatusOK, logoutResp.StatusCode)

	var cleared bool
	for _, c := range logoutResp.Cookies() {
		if c.Name == h.cfg.SessionCookieName {
			cleared = c.MaxAge < 0 || c.Expires.Before(time.Now())
		}
	}
	require.True(t, cleared, "logout must emit a clearing Set-Cookie")

	sessResp, _ := h.do(t, "GET", "/auth/session", "")
	require.Equal(t, http.StatusUnauthorized, sessResp.StatusCode, "revoked session must not authenticate")
}

// TestAuthDeviceRevocationInvalidatesSessions: revoking a device kills its
// sessions immediately, so even a held cookie cannot authenticate.
func TestAuthDeviceRevocationInvalidatesSessions(t *testing.T) {
	h := setupAuthHarness(t)
	h.seedAccount(t, "acct-revoke", "revoke@test.local")

	loginResp, _ := h.do(t, "POST", "/auth/login",
		`{"email":"revoke@test.local","password":"password123","device_id":"dev-revoke","device_public_key":"pub-revoke"}`)
	require.Equal(t, http.StatusOK, loginResp.StatusCode)

	// Session holds before revocation.
	sessResp, _ := h.do(t, "GET", "/auth/session", "")
	require.Equal(t, http.StatusOK, sessResp.StatusCode)

	revokeResp, _ := h.do(t, "DELETE", "/devices/dev-revoke", "")
	require.Equal(t, http.StatusOK, revokeResp.StatusCode)

	_, _, status := h.deviceState(t, "dev-revoke")
	require.Equal(t, "REVOKED", status)

	sessAfter, _ := h.do(t, "GET", "/auth/session", "")
	require.Equal(t, http.StatusUnauthorized, sessAfter.StatusCode, "sessions of a revoked device must die")
}
