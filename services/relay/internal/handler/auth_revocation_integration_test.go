package handler

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/TalibMushtaq/nodus/services/relay/internal/auth"
	"github.com/TalibMushtaq/nodus/services/relay/internal/config"
	"github.com/TalibMushtaq/nodus/services/relay/internal/db"
)

// This file covers the session-lifecycle half of the credential-remediation work:
//
//   - a password change revokes every other session, not just the caller's;
//   - recovery (the credential-reset path) revokes every pre-existing session;
//   - rotating the recovery key re-verifies the account password, and a rejected
//     attempt must leave both the stored key and the stale envelopes untouched.
//
// The last point is why the password check exists: an attacker holding a stolen
// session could otherwise enroll their own key and let the envelope deletes
// land, permanently bricking the real owner's recovery.

// setupRecoveryHarness mounts the recovery and account-recovery routes on the
// shared auth harness so they share the pool, session store, and cookie plumbing.
func setupRecoveryHarness(t *testing.T) *authHarness {
	t.Helper()
	return setupAuthHarnessWithRoutes(t, func(mux *http.ServeMux, pool *db.Pool, store auth.SessionStore, cfg *config.Config) {
		mux.HandleFunc("POST /auth/recovery/challenge", RecoveryChallenge(pool, cfg))
		mux.HandleFunc("POST /auth/recovery", Recover(pool, store, cfg))
		mux.Handle("PUT /account/recovery", auth.RequireAuth(store, cfg)(UpdateRecoveryKey(pool)))
	})
}

// recoveryKeypair returns a base64 Ed25519 public key and its signer, standing
// in for a key derived from the BIP39 phrase the user keeps offline.
func recoveryKeypair(t *testing.T) (pubB64 string, priv ed25519.PrivateKey) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	require.NoError(t, err)
	return base64.StdEncoding.EncodeToString(pub), priv
}

func (h *authHarness) setRecoveryKey(t *testing.T, accountID, pubB64 string) {
	t.Helper()
	_, err := h.pool.Exec(h.ctx,
		`UPDATE accounts SET recovery_public_key = $1 WHERE account_id = $2`, pubB64, accountID)
	require.NoError(t, err)
}

func (h *authHarness) recoveryKey(t *testing.T, accountID string) string {
	t.Helper()
	var key *string
	require.NoError(t, h.pool.QueryRow(h.ctx,
		`SELECT recovery_public_key FROM accounts WHERE account_id = $1`, accountID).Scan(&key))
	if key == nil {
		return ""
	}
	return *key
}

// TestChangePasswordRevokesOtherSessions covers the finding that a password
// change only rotated the caller's own token, leaving every other borrowed or
// stolen session alive against the new credential.
func TestChangePasswordRevokesOtherSessions(t *testing.T) {
	h := setupAuthHarness(t)
	u := fmt.Sprintf("%d", time.Now().UnixNano())
	email := "chpw-revoke-" + u + "@test.local"
	deviceA := "dev-chpw-rv-a-" + u
	deviceB := "dev-chpw-rv-b-" + u

	regResp, _ := h.doBare(t, "POST", "/auth/register",
		fmt.Sprintf(`{"email":%q,"password":"password123","device_id":%q,"device_public_key":"pubA"}`, email, deviceA))
	require.Equal(t, http.StatusCreated, regResp.StatusCode)
	aCookie := sessionCookieFrom(t, regResp, h.cfg.SessionCookieName)

	loginResp, _ := h.doBare(t, "POST", "/auth/login",
		fmt.Sprintf(`{"email":%q,"password":"password123","device_id":%q,"device_public_key":"pubB"}`, email, deviceB))
	require.Equal(t, http.StatusOK, loginResp.StatusCode)
	bCookie := sessionCookieFrom(t, loginResp, h.cfg.SessionCookieName)

	preResp, _ := h.doWithCookie(t, "GET", "/auth/session", "", bCookie)
	require.Equal(t, http.StatusOK, preResp.StatusCode, "precondition: B is signed in")

	chResp, chOut := h.doWithCookie(t, "POST", "/auth/password",
		`{"current_password":"password123","new_password":"newpassword456"}`, aCookie)
	require.Equal(t, http.StatusOK, chResp.StatusCode)
	require.Equal(t, deviceA, chOut.DeviceID, "the acting device keeps a session")
	newACookie := sessionCookieFrom(t, chResp, h.cfg.SessionCookieName)

	bResp, _ := h.doWithCookie(t, "GET", "/auth/session", "", bCookie)
	require.Equal(t, http.StatusUnauthorized, bResp.StatusCode,
		"a password change must end every other session, not just rotate the caller's")

	oldAResp, _ := h.doWithCookie(t, "GET", "/auth/session", "", aCookie)
	require.Equal(t, http.StatusUnauthorized, oldAResp.StatusCode, "the pre-change token is dead")

	newAResp, _ := h.doWithCookie(t, "GET", "/auth/session", "", newACookie)
	require.Equal(t, http.StatusOK, newAResp.StatusCode, "the acting device holds a fresh session")
}

// TestRecoverRevokesPriorSessions covers the recovery path. Recovery exists
// precisely for a user who has lost access, so any session that predates it
// cannot be trusted and must not remain a second way into the account.
func TestRecoverRevokesPriorSessions(t *testing.T) {
	h := setupRecoveryHarness(t)
	u := fmt.Sprintf("%d", time.Now().UnixNano())
	email := "recover-revoke-" + u + "@test.local"
	oldDevice := "dev-rec-old-" + u
	newDevice := "dev-rec-new-" + u

	regResp, out := h.doBare(t, "POST", "/auth/register",
		fmt.Sprintf(`{"email":%q,"password":"password123","device_id":%q,"device_public_key":"pubA"}`, email, oldDevice))
	require.Equal(t, http.StatusCreated, regResp.StatusCode)
	oldCookie := sessionCookieFrom(t, regResp, h.cfg.SessionCookieName)

	pubB64, priv := recoveryKeypair(t)
	h.setRecoveryKey(t, out.AccountID, pubB64)

	challengeResp, challengeOut := h.doBare(t, "POST", "/auth/recovery/challenge",
		fmt.Sprintf(`{"email":%q}`, email))
	require.Equal(t, http.StatusOK, challengeResp.StatusCode)
	require.Equal(t, pubB64, challengeOut.RecoveryPublicKey, "the challenge advertises the enrolled key")

	recResp, recOut := h.doBare(t, "POST", "/auth/recovery", fmt.Sprintf(
		`{"email":%q,"nonce":%q,"signature":%q,"device_id":%q,"device_public_key":"pubNew","device_encryption_public_key":%q}`,
		email, challengeOut.Nonce, hex.EncodeToString(ed25519.Sign(priv, []byte(challengeOut.Nonce))),
		newDevice, base64.StdEncoding.EncodeToString(make([]byte, 32))))
	require.Equal(t, http.StatusOK, recResp.StatusCode, "recovery failed: %s", recOut.Error)
	require.Equal(t, newDevice, recOut.DeviceID)
	newCookie := sessionCookieFrom(t, recResp, h.cfg.SessionCookieName)

	oldResp, _ := h.doWithCookie(t, "GET", "/auth/session", "", oldCookie)
	require.Equal(t, http.StatusUnauthorized, oldResp.StatusCode,
		"a session captured before recovery must not survive it")

	newResp, _ := h.doWithCookie(t, "GET", "/auth/session", "", newCookie)
	require.Equal(t, http.StatusOK, newResp.StatusCode, "the recovering device holds a session")
}

// TestUpdateRecoveryKeyRequiresCurrentPassword asserts the re-authentication
// gate, and critically that a rejected attempt is inert: neither the stored key
// nor the previous key's envelope coverage may move.
func TestUpdateRecoveryKeyRequiresCurrentPassword(t *testing.T) {
	h := setupRecoveryHarness(t)
	u := fmt.Sprintf("%d", time.Now().UnixNano())
	email := "rotkey-" + u + "@test.local"
	device := "dev-rotkey-" + u

	regResp, out := h.doBare(t, "POST", "/auth/register",
		fmt.Sprintf(`{"email":%q,"password":"password123","device_id":%q,"device_public_key":"pubA"}`, email, device))
	require.Equal(t, http.StatusCreated, regResp.StatusCode)
	cookie := sessionCookieFrom(t, regResp, h.cfg.SessionCookieName)
	accountID := out.AccountID

	oldKey, _ := recoveryKeypair(t)
	h.setRecoveryKey(t, accountID, oldKey)
	newKey, _ := recoveryKeypair(t)

	// A file and folder sealed to the old key stand in for real recovery
	// coverage; both must survive a refused rotation.
	fileID, folderID := "file-"+u, "folder-"+u
	_, err := h.pool.Exec(h.ctx, `INSERT INTO files (file_id, account_id) VALUES ($1, $2)`, fileID, accountID)
	require.NoError(t, err)
	_, err = h.pool.Exec(h.ctx, `INSERT INTO folders (folder_id, account_id) VALUES ($1, $2)`, folderID, accountID)
	require.NoError(t, err)
	_, err = h.pool.Exec(h.ctx,
		`INSERT INTO key_envelopes (file_id, recipient_id, recipient_kind, encrypted_key) VALUES ($1, $2, 'recovery', 'sealed')`,
		fileID, oldKey)
	require.NoError(t, err)
	_, err = h.pool.Exec(h.ctx,
		`INSERT INTO folder_key_envelopes (folder_id, recipient_id, recipient_kind, encrypted_key) VALUES ($1, $2, 'recovery', 'sealed')`,
		folderID, oldKey)
	require.NoError(t, err)

	// coverage counts the recovery envelopes still present, i.e. how much of the
	// account the real owner's old phrase can still open.
	coverage := func() (file, folder int) {
		require.NoError(t, h.pool.QueryRow(h.ctx,
			`SELECT count(*) FROM key_envelopes WHERE file_id = $1 AND recipient_kind = 'recovery'`, fileID).Scan(&file))
		require.NoError(t, h.pool.QueryRow(h.ctx,
			`SELECT count(*) FROM folder_key_envelopes WHERE folder_id = $1 AND recipient_kind = 'recovery'`, folderID).Scan(&folder))
		return file, folder
	}

	// Missing field: 400, and nothing is touched.
	missingResp, _ := h.doWithCookie(t, "PUT", "/account/recovery",
		fmt.Sprintf(`{"recovery_public_key":%q}`, newKey), cookie)
	require.Equal(t, http.StatusBadRequest, missingResp.StatusCode)
	require.Equal(t, oldKey, h.recoveryKey(t, accountID), "a missing password must not rotate the key")

	// Wrong password: 401, and nothing is touched.
	wrongResp, _ := h.doWithCookie(t, "PUT", "/account/recovery",
		fmt.Sprintf(`{"recovery_public_key":%q,"current_password":"not-the-password"}`, newKey), cookie)
	require.Equal(t, http.StatusUnauthorized, wrongResp.StatusCode)
	require.Equal(t, oldKey, h.recoveryKey(t, accountID), "a wrong password must not rotate the key")
	fileCount, folderCount := coverage()
	require.Equal(t, 1, fileCount, "a refused rotation must not drop the old key's file coverage")
	require.Equal(t, 1, folderCount, "a refused rotation must not drop the old key's folder coverage")

	// Correct password: rotates, and drops only the previous key's coverage.
	okResp, _ := h.doWithCookie(t, "PUT", "/account/recovery",
		fmt.Sprintf(`{"recovery_public_key":%q,"current_password":"password123"}`, newKey), cookie)
	require.Equal(t, http.StatusOK, okResp.StatusCode)
	require.Equal(t, newKey, h.recoveryKey(t, accountID), "an authorized rotation applies")
	fileCount, folderCount = coverage()
	require.Equal(t, 0, fileCount, "the old key's file coverage is dropped on rotation")
	require.Equal(t, 0, folderCount, "the old key's folder coverage is dropped on rotation")
}
