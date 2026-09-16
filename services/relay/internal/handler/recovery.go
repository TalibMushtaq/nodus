package handler

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/TalibMushtaq/nodus/services/relay/internal/auth"
	"github.com/TalibMushtaq/nodus/services/relay/internal/config"
	"github.com/TalibMushtaq/nodus/services/relay/internal/db"
)

// recoveryChallengeTTL bounds how long an issued nonce can be signed. Short
// enough that a leaked signature is useless, long enough for a slow network.
const recoveryChallengeTTL = 5 * time.Minute

// UpdateRecoveryKeyRequest enrolls or rotates the account's recovery identity.
// The key is public (the matching phrase stays client-side), so this is an
// authenticated write rather than a secret handover.
type UpdateRecoveryKeyRequest struct {
	RecoveryPublicKey string `json:"recovery_public_key"`
}

// UpdateRecoveryKey sets the account recovery public key and drops any recovery
// envelopes addressed to the previous key. The caller (a trusted device) is
// expected to re-seal every file/folder key to the new identity — before or
// after enrolling — so recovery coverage is restored; this endpoint only removes
// the stale-key envelopes and never touches envelopes for the new key.
func UpdateRecoveryKey(pool *db.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		accountID, ok := auth.GetAccountID(r.Context())
		if !ok {
			respondError(w, http.StatusUnauthorized, "unauthorized")
			return
		}

		r.Body = http.MaxBytesReader(w, r.Body, 8<<10)
		var req UpdateRecoveryKeyRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			respondError(w, http.StatusBadRequest, "invalid request body")
			return
		}
		req.RecoveryPublicKey = strings.TrimSpace(req.RecoveryPublicKey)
		// Validate up front: a malformed key must fail here with 400, not be
		// stored and then brick the account's recovery later (Recover would
		// otherwise hit a 500 on the stored value).
		pubKey, err := base64.StdEncoding.DecodeString(req.RecoveryPublicKey)
		if err != nil || len(pubKey) != ed25519.PublicKeySize {
			respondError(w, http.StatusBadRequest, "recovery_public_key must be a 32-byte base64 Ed25519 public key")
			return
		}

		tx, err := pool.Begin(r.Context())
		if err != nil {
			respondError(w, http.StatusInternalServerError, "failed to start transaction")
			return
		}
		defer tx.Rollback(r.Context()) // nolint:errcheck

		// Read the previous key so stale-key envelopes can be dropped without
		// touching envelopes addressed to the newly enrolled key.
		var oldKey *string
		if err := tx.QueryRow(r.Context(),
			"SELECT recovery_public_key FROM accounts WHERE account_id = $1", accountID,
		).Scan(&oldKey); err != nil {
			respondError(w, http.StatusInternalServerError, "failed to read recovery key")
			return
		}

		if _, err := tx.Exec(r.Context(),
			"UPDATE accounts SET recovery_public_key = $1 WHERE account_id = $2",
			req.RecoveryPublicKey, accountID,
		); err != nil {
			respondError(w, http.StatusInternalServerError, "failed to update recovery key")
			return
		}

		// Envelopes are account-scoped through their parent file/folder, so the
		// delete joins to keep one account from touching another's rows. The
		// recipient_id pin means only the previous key's coverage is removed.
		if oldKey != nil && *oldKey != req.RecoveryPublicKey {
			if _, err := tx.Exec(r.Context(), `
				DELETE FROM key_envelopes ke
				USING files f
				WHERE ke.file_id = f.file_id AND f.account_id = $1
				  AND ke.recipient_kind = 'recovery' AND ke.recipient_id = $2
			`, accountID, *oldKey); err != nil {
				respondError(w, http.StatusInternalServerError, "failed to clear old recovery envelopes")
				return
			}
			if _, err := tx.Exec(r.Context(), `
				DELETE FROM folder_key_envelopes fe
				USING folders fo
				WHERE fe.folder_id = fo.folder_id AND fo.account_id = $1
				  AND fe.recipient_kind = 'recovery' AND fe.recipient_id = $2
			`, accountID, *oldKey); err != nil {
				respondError(w, http.StatusInternalServerError, "failed to clear old folder recovery envelopes")
				return
			}
		}

		if err := tx.Commit(r.Context()); err != nil {
			respondError(w, http.StatusInternalServerError, "failed to commit recovery key update")
			return
		}

		respondJSON(w, http.StatusOK, map[string]string{"recovery_public_key": req.RecoveryPublicKey})
	}
}

type RecoveryChallengeRequest struct {
	Email string `json:"email"`
}

type RecoveryChallengeResponse struct {
	Nonce             string    `json:"nonce"`
	ExpiresAt         time.Time `json:"expires_at"`
	RecoveryPublicKey string    `json:"recovery_public_key"`
}

// RecoveryChallenge issues a single-use nonce for a recovery attempt. The email
// identifies the account; the account's recovery public key is returned so the
// client can confirm the phrase matches before signing. Returns 401 (same as
// Recover, so the two open endpoints do not disagree about failure semantics)
// when the account does not exist or has no recovery key enrolled.
func RecoveryChallenge(pool *db.Pool, cfg *config.Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Open endpoint (the phrase is the credential): throttle by IP so a
		// caller cannot mint an unbounded number of nonce rows.
		if !recoveryLimiter.Allow(clientIP(r, cfg)) {
			respondError(w, http.StatusTooManyRequests, "rate_limit_exceeded")
			return
		}

		r.Body = http.MaxBytesReader(w, r.Body, 8<<10)
		var req RecoveryChallengeRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			respondError(w, http.StatusBadRequest, "invalid request body")
			return
		}
		email := strings.TrimSpace(strings.ToLower(req.Email))
		if email == "" {
			respondError(w, http.StatusBadRequest, "email is required")
			return
		}

		var (
			accountID         string
			recoveryPublicKey *string
		)
		err := pool.QueryRow(r.Context(),
			"SELECT account_id, recovery_public_key FROM accounts WHERE email = $1", email,
		).Scan(&accountID, &recoveryPublicKey)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				respondError(w, http.StatusUnauthorized, "recovery_unavailable")
				return
			}
			respondError(w, http.StatusInternalServerError, "database error")
			return
		}
		if recoveryPublicKey == nil {
			respondError(w, http.StatusUnauthorized, "recovery_unavailable")
			return
		}

		// Opportunistic cleanup so the nonce table cannot grow without bound.
		// Best-effort: a cleanup failure must not block issuing a challenge.
		_, _ = pool.Exec(r.Context(), "DELETE FROM recovery_challenges WHERE expires_at < NOW()")

		nonceBytes := make([]byte, 32)
		if _, err := rand.Read(nonceBytes); err != nil {
			respondError(w, http.StatusInternalServerError, "failed to issue challenge")
			return
		}
		nonce := hex.EncodeToString(nonceBytes)
		expiresAt := time.Now().UTC().Add(recoveryChallengeTTL)
		if _, err := pool.Exec(r.Context(),
			"INSERT INTO recovery_challenges (nonce, account_id, expires_at) VALUES ($1, $2, $3)",
			nonce, accountID, expiresAt,
		); err != nil {
			respondError(w, http.StatusInternalServerError, "failed to issue challenge")
			return
		}

		respondJSON(w, http.StatusOK, RecoveryChallengeResponse{
			Nonce:             nonce,
			ExpiresAt:         expiresAt,
			RecoveryPublicKey: *recoveryPublicKey,
		})
	}
}

type RecoverRequest struct {
	Email           string `json:"email"`
	Nonce           string `json:"nonce"`
	Signature       string `json:"signature"`
	DeviceID        string `json:"device_id"`
	DevicePublicKey string `json:"device_public_key"`
	// DeviceEncryptionPublicKey is the recovered device's X25519 key (base64, ADR-0008).
	DeviceEncryptionPublicKey string `json:"device_encryption_public_key"`
}

// Recover authenticates a new device with a signature from the account recovery
// key, registers that device, and mints a session. No password is required:
// possession of the offline phrase is the recovery credential (ADR-0002). The
// nonce is single-use and expires, so a captured signature cannot be replayed.
//
// The nonce is claimed atomically: the FOR UPDATE lock serializes concurrent
// requests carrying the same nonce (plain READ COMMITTED would let a second
// request read used_at = NULL and mint a second session). A rejected attempt —
// wrong signature or a device owned by another account — rolls the transaction
// back and leaves the nonce usable, so a client typo does not burn it.
func Recover(pool *db.Pool, store auth.SessionStore, cfg *config.Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !recoveryLimiter.Allow(clientIP(r, cfg)) {
			respondError(w, http.StatusTooManyRequests, "rate_limit_exceeded")
			return
		}

		r.Body = http.MaxBytesReader(w, r.Body, 16<<10)
		var req RecoverRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			respondError(w, http.StatusBadRequest, "invalid request body")
			return
		}
		email := strings.TrimSpace(strings.ToLower(req.Email))
		if email == "" || req.Nonce == "" || req.Signature == "" || req.DeviceID == "" || req.DevicePublicKey == "" {
			respondError(w, http.StatusBadRequest, "email, nonce, signature, device_id and device_public_key are required")
			return
		}

		var (
			accountID         string
			recoveryPublicKey *string
		)
		err := pool.QueryRow(r.Context(),
			"SELECT account_id, recovery_public_key FROM accounts WHERE email = $1", email,
		).Scan(&accountID, &recoveryPublicKey)
		if err != nil || recoveryPublicKey == nil {
			respondError(w, http.StatusUnauthorized, "recovery_unavailable")
			return
		}

		pubKey, err := base64.StdEncoding.DecodeString(*recoveryPublicKey)
		if err != nil || len(pubKey) != ed25519.PublicKeySize {
			respondError(w, http.StatusInternalServerError, "stored recovery key is invalid")
			return
		}
		sig, err := hex.DecodeString(req.Signature)
		if err != nil || len(sig) != ed25519.SignatureSize {
			respondError(w, http.StatusUnauthorized, "invalid_signature")
			return
		}

		tx, err := pool.Begin(r.Context())
		if err != nil {
			respondError(w, http.StatusInternalServerError, "database error")
			return
		}
		defer tx.Rollback(r.Context()) // nolint:errcheck

		// Lock the nonce row for the life of the claim so a concurrently
		// submitted copy of the same nonce blocks here and then fails the
		// used_at check below.
		var (
			challengeAccount string
			expiresAt        time.Time
			usedAt           *time.Time
		)
		err = tx.QueryRow(r.Context(),
			"SELECT account_id, expires_at, used_at FROM recovery_challenges WHERE nonce = $1 FOR UPDATE", req.Nonce,
		).Scan(&challengeAccount, &expiresAt, &usedAt)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				respondError(w, http.StatusUnauthorized, "invalid_or_expired_challenge")
				return
			}
			respondError(w, http.StatusInternalServerError, "database error")
			return
		}
		if usedAt != nil || challengeAccount != accountID || time.Now().UTC().After(expiresAt) {
			respondError(w, http.StatusUnauthorized, "invalid_or_expired_challenge")
			return
		}

		// The nonce is signed verbatim as the hex string bytes, matching the
		// client's signing helper, so no encoding ambiguity survives.
		if !ed25519.Verify(ed25519.PublicKey(pubKey), []byte(req.Nonce), sig) {
			respondError(w, http.StatusUnauthorized, "invalid_signature")
			return
		}

		// Device upsert and nonce consumption commit together, so a collision
		// (device owned by another account) leaves the nonce usable.
		if _, err := upsertDeviceForAccount(tx, r, req.DeviceID, req.DevicePublicKey, req.DeviceEncryptionPublicKey, accountID); err != nil {
			respondDeviceUpsertError(w, err)
			return
		}
		if _, err := tx.Exec(r.Context(),
			"UPDATE recovery_challenges SET used_at = NOW() WHERE nonce = $1", req.Nonce,
		); err != nil {
			respondError(w, http.StatusInternalServerError, "failed to consume challenge")
			return
		}

		if err := tx.Commit(r.Context()); err != nil {
			respondError(w, http.StatusInternalServerError, "failed to commit recovery")
			return
		}

		issueSession(w, r, store, cfg, accountID, req.DeviceID, recoveryPublicKey, http.StatusOK)
	}
}
