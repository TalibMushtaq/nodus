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
	mux.HandleFunc("GET /auth/session", Session(pool, store, cfg))
	mux.HandleFunc("POST /auth/logout", Logout(store, cfg))
	mux.Handle("POST /auth/password", auth.RequireAuth(store, cfg)(ChangePassword(pool, store, cfg)))
	mux.Handle("POST /auth/logout-all", auth.RequireAuth(store, cfg)(LogoutAll(pool, store, cfg)))
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

// TestAuthSessionCookieFlags asserts the §5 cookie security contract: HttpOnly,
// Path=/, SameSite=Lax are always set; Secure depends on config (false in test
// because httptest speaks plain HTTP).
func TestAuthSessionCookieFlags(t *testing.T) {
	h := setupAuthHarness(t)
	h.seedAccount(t, "acct-cookies", "cookies@test.local")

	resp, _ := h.do(t, "POST", "/auth/login",
		`{"email":"cookies@test.local","password":"password123","device_id":"dev-cookies","device_public_key":"pub-cookies"}`)
	require.Equal(t, http.StatusOK, resp.StatusCode)

	var sessionCookie *http.Cookie
	for _, c := range resp.Cookies() {
		if c.Name == h.cfg.SessionCookieName {
			sessionCookie = c
			break
		}
	}
	require.NotNil(t, sessionCookie, "response must set the session cookie")

	require.True(t, sessionCookie.HttpOnly, "cookie must be HttpOnly")
	require.Equal(t, "/", sessionCookie.Path, "cookie must have Path=/")
	require.Equal(t, http.SameSiteLaxMode, sessionCookie.SameSite, "cookie must be SameSite=Lax")
	// Secure=false in test (plain HTTP); production default is true.
	require.False(t, sessionCookie.Secure, "Secure should be false in test (plain HTTP)")
}

// TestAuthSessionCookieSecureFlag verifies the Secure flag is set when
// SESSION_COOKIE_SECURE=true (production mode). A separate server is spun up
// with Secure=true to validate the cookie attribute end to end.
func TestAuthSessionCookieSecureFlag(t *testing.T) {
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set; skipping integration test")
	}

	ctx := context.Background()
	require.NoError(t, db.RunMigrations(url))
	pool, err := db.Open(ctx, &config.Config{DatabaseURL: url})
	require.NoError(t, err)
	t.Cleanup(pool.Close)

	cfg := &config.Config{
		SessionCookieName:    "nodus_session",
		SessionMaxAge:        30 * 24 * time.Hour,
		SessionTouchInterval: 30 * time.Minute,
		SessionCookieSecure:  true, // production mode
	}
	store := auth.NewPGSessionStore(pool, cfg)

	mux := http.NewServeMux()
	mux.HandleFunc("POST /auth/register", Register(pool, store, cfg))
	mux.HandleFunc("POST /auth/login", Login(pool, store, cfg))
	mux.HandleFunc("GET /auth/session", Session(pool, store, cfg))
	mux.HandleFunc("POST /auth/logout", Logout(store, cfg))
	mux.Handle("DELETE /devices/{id}", auth.RequireAuth(store, cfg)(RevokeDevice(pool, store)))

	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)

	// No cookie jar — inspect raw Set-Cookie headers.
	client := &http.Client{Jar: nil}

	u := fmt.Sprintf("%d", time.Now().UnixNano())
	email := "secure-cookie-" + u + "@test.local"
	device := "dev-secure-" + u

	req, err := http.NewRequest("POST", server.URL+"/auth/register",
		bytes.NewReader([]byte(fmt.Sprintf(`{"email":%q,"password":"password123","device_id":%q,"device_public_key":"pub-secure"}`, email, device))))
	require.NoError(t, err)
	req.Header.Set("Content-Type", "application/json")

	resp, err := client.Do(req)
	require.NoError(t, err)
	resp.Body.Close()
	require.Equal(t, http.StatusCreated, resp.StatusCode)

	var sessionCookie *http.Cookie
	for _, c := range resp.Cookies() {
		if c.Name == cfg.SessionCookieName {
			sessionCookie = c
			break
		}
	}
	require.NotNil(t, sessionCookie, "response must set the session cookie")
	require.True(t, sessionCookie.Secure, "Secure must be true in production mode")
	require.True(t, sessionCookie.HttpOnly, "cookie must be HttpOnly")
	require.Equal(t, "/", sessionCookie.Path, "cookie must have Path=/")
	require.Equal(t, http.SameSiteLaxMode, sessionCookie.SameSite, "cookie must be SameSite=Lax")
}

// sessionCookieFrom extracts a named cookie value from a response's Set-Cookie
// headers, failing the test if the cookie was not set.
func sessionCookieFrom(t *testing.T, resp *http.Response, name string) string {
	t.Helper()
	for _, c := range resp.Cookies() {
		if c.Name == name {
			return c.Value
		}
	}
	t.Fatalf("response did not set cookie %s", name)
	return ""
}

// doBare issues an unauthenticated request with a fresh cookie-less client, so
// a test can obtain a session without disturbing the harness cookie jar.
func (h *authHarness) doBare(t *testing.T, method, path, body string) (*http.Response, authResponse) {
	t.Helper()
	req, err := http.NewRequest(method, h.server.URL+path, bytes.NewReader([]byte(body)))
	require.NoError(t, err)
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := (&http.Client{}).Do(req)
	require.NoError(t, err)
	var out authResponse
	_ = json.NewDecoder(resp.Body).Decode(&out)
	resp.Body.Close()
	return resp, out
}

// doWithCookie issues a request with an explicit Cookie header and no jar, so a
// superseded or foreign raw token can be probed independently of the jar.
func (h *authHarness) doWithCookie(t *testing.T, method, path, body, cookie string) (*http.Response, authResponse) {
	t.Helper()
	req, err := http.NewRequest(method, h.server.URL+path, bytes.NewReader([]byte(body)))
	require.NoError(t, err)
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Cookie", h.cfg.SessionCookieName+"="+cookie)
	resp, err := (&http.Client{}).Do(req)
	require.NoError(t, err)
	var out authResponse
	_ = json.NewDecoder(resp.Body).Decode(&out)
	resp.Body.Close()
	return resp, out
}

// TestRawSessionToken covers the cookie/bearer fallback used by rotation.
func TestRawSessionToken(t *testing.T) {
	cfg := &config.Config{SessionCookieName: "nodus_session"}

	withCookie := httptest.NewRequest("POST", "/auth/password", nil)
	withCookie.AddCookie(&http.Cookie{Name: "nodus_session", Value: "cookie-token"})
	require.Equal(t, "cookie-token", rawSessionToken(withCookie, cfg), "cookie wins when present")

	withBearer := httptest.NewRequest("POST", "/auth/password", nil)
	withBearer.Header.Set("Authorization", "Bearer bearer-token")
	require.Equal(t, "bearer-token", rawSessionToken(withBearer, cfg), "bearer is the mobile fallback")

	empty := httptest.NewRequest("POST", "/auth/password", nil)
	require.Equal(t, "", rawSessionToken(empty, cfg), "no credential yields empty")
}

// TestChangePasswordRotatesSession asserts the §13 fixation defense: a successful
// password change reverses the old session id, the old cookie stops working, and
// only the new password authenticates afterwards.
func TestChangePasswordRotatesSession(t *testing.T) {
	h := setupAuthHarness(t)
	u := fmt.Sprintf("%d", time.Now().UnixNano())
	email := "chpw-" + u + "@test.local"
	device := "dev-chpw-" + u

	regResp, _ := h.do(t, "POST", "/auth/register",
		fmt.Sprintf(`{"email":%q,"password":"password123","device_id":%q,"device_public_key":"pub"}`, email, device))
	require.Equal(t, http.StatusCreated, regResp.StatusCode)
	oldCookie := sessionCookieFrom(t, regResp, h.cfg.SessionCookieName)

	resp, out := h.do(t, "POST", "/auth/password",
		`{"current_password":"password123","new_password":"newpassword456"}`)
	require.Equal(t, http.StatusOK, resp.StatusCode)
	require.Equal(t, device, out.DeviceID)
	newCookie := sessionCookieFrom(t, resp, h.cfg.SessionCookieName)
	require.NotEqual(t, oldCookie, newCookie, "rotation must issue a new session id")

	oldResp, _ := h.doWithCookie(t, "GET", "/auth/session", "", oldCookie)
	require.Equal(t, http.StatusUnauthorized, oldResp.StatusCode, "pre-change cookie must be invalid")

	newResp, _ := h.doWithCookie(t, "GET", "/auth/session", "", newCookie)
	require.Equal(t, http.StatusOK, newResp.StatusCode, "rotated cookie must be valid")

	badLogin, _ := h.doBare(t, "POST", "/auth/login",
		fmt.Sprintf(`{"email":%q,"password":"password123","device_id":%q,"device_public_key":"pub"}`, email, device))
	require.Equal(t, http.StatusUnauthorized, badLogin.StatusCode, "old password must stop working")

	goodLogin, _ := h.doBare(t, "POST", "/auth/login",
		fmt.Sprintf(`{"email":%q,"password":"newpassword456","device_id":%q,"device_public_key":"pub"}`, email, device))
	require.Equal(t, http.StatusOK, goodLogin.StatusCode, "new password must authenticate")
}

// TestChangePasswordRejectsWrongCurrent ensures a stolen cookie cannot change
// the password without the current credential, and validation does not mutate.
func TestChangePasswordRejectsWrongCurrent(t *testing.T) {
	h := setupAuthHarness(t)
	u := fmt.Sprintf("%d", time.Now().UnixNano())
	email := "chpw-bad-" + u + "@test.local"
	device := "dev-chpw-bad-" + u

	regResp, _ := h.do(t, "POST", "/auth/register",
		fmt.Sprintf(`{"email":%q,"password":"password123","device_id":%q,"device_public_key":"pub"}`, email, device))
	require.Equal(t, http.StatusCreated, regResp.StatusCode)

	wrongResp, _ := h.do(t, "POST", "/auth/password",
		`{"current_password":"not-the-password","new_password":"newpassword456"}`)
	require.Equal(t, http.StatusUnauthorized, wrongResp.StatusCode)

	shortResp, _ := h.do(t, "POST", "/auth/password",
		`{"current_password":"password123","new_password":"short"}`)
	require.Equal(t, http.StatusBadRequest, shortResp.StatusCode)

	sessResp, _ := h.do(t, "GET", "/auth/session", "")
	require.Equal(t, http.StatusOK, sessResp.StatusCode, "failed change must not end the session")
}

// TestLogoutAllRevokesOtherSessions asserts "sign out everywhere": a second
// device's session is invalidated, while the caller is handed a fresh session.
func TestLogoutAllRevokesOtherSessions(t *testing.T) {
	h := setupAuthHarness(t)
	u := fmt.Sprintf("%d", time.Now().UnixNano())
	email := "logout-all-" + u + "@test.local"
	deviceA := "dev-la-a-" + u
	deviceB := "dev-la-b-" + u

	regResp, outA := h.doBare(t, "POST", "/auth/register",
		fmt.Sprintf(`{"email":%q,"password":"password123","device_id":%q,"device_public_key":"pubA"}`, email, deviceA))
	require.Equal(t, http.StatusCreated, regResp.StatusCode)
	aCookie := sessionCookieFrom(t, regResp, h.cfg.SessionCookieName)

	loginResp, outB := h.doBare(t, "POST", "/auth/login",
		fmt.Sprintf(`{"email":%q,"password":"password123","device_id":%q,"device_public_key":"pubB"}`, email, deviceB))
	require.Equal(t, http.StatusOK, loginResp.StatusCode)
	require.Equal(t, outA.AccountID, outB.AccountID, "both devices share the account")
	bCookie := sessionCookieFrom(t, loginResp, h.cfg.SessionCookieName)

	laResp, laOut := h.doWithCookie(t, "POST", "/auth/logout-all", "", aCookie)
	require.Equal(t, http.StatusOK, laResp.StatusCode)
	require.Equal(t, deviceA, laOut.DeviceID)
	newACookie := sessionCookieFrom(t, laResp, h.cfg.SessionCookieName)

	bResp, _ := h.doWithCookie(t, "GET", "/auth/session", "", bCookie)
	require.Equal(t, http.StatusUnauthorized, bResp.StatusCode, "other device must be signed out")

	oldResp, _ := h.doWithCookie(t, "GET", "/auth/session", "", aCookie)
	require.Equal(t, http.StatusUnauthorized, oldResp.StatusCode, "revoke-all invalidates the calling token too")

	newResp, _ := h.doWithCookie(t, "GET", "/auth/session", "", newACookie)
	require.Equal(t, http.StatusOK, newResp.StatusCode, "caller keeps a fresh session")
}
