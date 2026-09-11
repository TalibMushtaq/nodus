package handler

import (
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/TalibMushtaq/nodus/services/relay/internal/auth"
	"github.com/TalibMushtaq/nodus/services/relay/internal/config"
	"github.com/TalibMushtaq/nodus/services/relay/internal/db"
)

const pairingCodeTTL = 15 * time.Minute

// CreatePairingCode mints a one-time NODUS-XXXX-XXXX pairing code for the
// authenticated account. The plaintext is returned exactly once in the
// response; only its SHA-256 hash is stored.
func CreatePairingCode(pool *db.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		accountID, ok := auth.GetAccountID(r.Context())
		if !ok {
			respondError(w, http.StatusUnauthorized, "unauthorized")
			return
		}

		code, err := generatePairingCode()
		if err != nil {
			log.Printf("[pairing-codes] CSPRNG failure: %v", err)
			respondError(w, http.StatusInternalServerError, "failed to generate code")
			return
		}

		hash := hashCode(normalizeCode(code))
		expiresAt := time.Now().UTC().Add(pairingCodeTTL)

		// Opportunistic cleanup of this account's expired PENDING codes so the
		// table cannot grow without bound. Best-effort: a cleanup failure must
		// not block minting. Consumed rows are retained for auditability.
		_, _ = pool.Exec(r.Context(),
			`DELETE FROM pairing_codes
			 WHERE account_id = $1 AND status = 'PENDING' AND expires_at < NOW()`,
			accountID,
		)

		_, err = pool.Exec(r.Context(),
			`INSERT INTO pairing_codes (code_hash, account_id, expires_at)
			 VALUES ($1, $2, $3)`,
			hash, accountID, expiresAt,
		)
		if err != nil {
			log.Printf("[pairing-codes] insert failed for account %s: %v", accountID, err)
			respondError(w, http.StatusInternalServerError, "failed to store pairing code")
			return
		}

		respondJSON(w, http.StatusCreated, map[string]interface{}{
			"code":       code,
			"expires_at": expiresAt,
		})
	}
}

// RedeemRequest is the body of POST /pairing/codes/redeem. The code itself is
// the credential — no session cookie needed.
type RedeemRequest struct {
	Code      string `json:"code"`
	NodeID    string `json:"node_id"`
	PublicKey string `json:"public_key"`
}

// defaultNodeCapabilities matches the fallback RegisterNode assigns (node.go)
// so nodes registered via a pairing code are indistinguishable from direct ones.
const defaultNodeCapabilities = `["storage","sync"]`

// validNodeID enforces a light shape on node identifiers: non-empty, short,
// printable ASCII without whitespace. The canonical node_id is the 64-char hex
// Ed25519 identity (storage-node identity.rs), but legacy RegisterNode accepted
// arbitrary IDs, so redeem stays lenient to keep re-pairing those nodes working.
func validNodeID(id string) bool {
	if id == "" || len(id) > 128 {
		return false
	}
	for _, r := range id {
		if r < 0x21 || r > 0x7e { // printable ASCII, no whitespace/control chars
			return false
		}
	}
	return true
}

// RedeemPairingCode atomically consumes a pairing code and registers the
// requesting node under the code's issuing account. Open endpoint — the code
// is the auth.
func RedeemPairingCode(pool *db.Pool, cfg *config.Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !redeemLimiter.Allow(clientIP(r, cfg)) {
			respondError(w, http.StatusTooManyRequests, "rate_limit_exceeded")
			return
		}

		// Bound the body: this endpoint is open, so an unbounded decode would let
		// an unauthenticated caller allocate arbitrary memory. 16 KiB matches the
		// other JSON handlers (see auth.go).
		r.Body = http.MaxBytesReader(w, r.Body, 16<<10)

		var req RedeemRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			respondError(w, http.StatusBadRequest, "invalid request body")
			return
		}

		if req.Code == "" || req.PublicKey == "" {
			respondError(w, http.StatusBadRequest, "code and public_key are required")
			return
		}
		if !validNodeID(req.NodeID) {
			respondError(w, http.StatusBadRequest, "invalid node_id format")
			return
		}

		// Validate public_key is a hex-encoded Ed25519 public key (32 bytes).
		pubKeyBytes, err := hex.DecodeString(req.PublicKey)
		if err != nil || len(pubKeyBytes) != ed25519.PublicKeySize {
			respondError(w, http.StatusBadRequest, "invalid public_key format")
			return
		}

		codeHash := hashCode(normalizeCode(req.Code))

		// Consume and register inside a single transaction: a rejected or failed
		// registration rolls back the consume, so a valid code is never burned.
		tx, err := pool.Begin(r.Context())
		if err != nil {
			log.Printf("[pairing-codes] tx begin failed for hash %s: %v", codeHash, err)
			respondError(w, http.StatusInternalServerError, "failed to consume pairing code")
			return
		}
		defer tx.Rollback(r.Context())

		// Atomically consume the code: only a PENDING, unexpired row matches.
		var accountID string
		err = tx.QueryRow(r.Context(),
			`UPDATE pairing_codes
			 SET status = 'CONSUMED', consumed_at = NOW()
			 WHERE code_hash = $1
			   AND status = 'PENDING'
			   AND expires_at > NOW()
			 RETURNING account_id`,
			codeHash,
		).Scan(&accountID)

		if errors.Is(err, pgx.ErrNoRows) {
			// Distinguish unknown vs expired vs consumed vs revoked via a re-read.
			var (
				existingStatus string
				expiresAt      time.Time
			)
			rerr := tx.QueryRow(r.Context(),
				`SELECT status, expires_at FROM pairing_codes WHERE code_hash = $1`, codeHash,
			).Scan(&existingStatus, &expiresAt)
			if errors.Is(rerr, pgx.ErrNoRows) {
				respondError(w, http.StatusNotFound, "code_unknown")
				return
			}
			switch existingStatus {
			case "CONSUMED":
				respondError(w, http.StatusConflict, "code_consumed")
				return
			case "REVOKED":
				// Nothing revokes codes yet, but be explicit so a revoked code
				// never reads as a mere expiry.
				respondError(w, http.StatusGone, "code_revoked")
				return
			}
			// Must be expired (status still PENDING but expires_at <= now).
			respondError(w, http.StatusGone, "code_expired")
			return
		}
		if err != nil {
			log.Printf("[pairing-codes] consume failed for hash %s: %v", codeHash, err)
			respondError(w, http.StatusInternalServerError, "failed to consume pairing code")
			return
		}

		// Register the node under the code's issuing account through the shared
		// helper so this path and /nodes/register enforce the same identity
		// invariant: same node_id + same key is idempotent (no key replacement,
		// no reactivation), a changed key is rejected with node_key_mismatch, a
		// node owned by another account with node_owned_elsewhere (which rolls
		// back the consume, leaving the code PENDING so it is never burned), and
		// the account's first node becomes primary (DB-enforced by
		// idx_storage_nodes_one_primary).
		node, outcome, err := registerStorageNode(
			r.Context(), tx, accountID, req.NodeID, req.PublicKey, defaultNodeCapabilities,
		)
		if err != nil {
			log.Printf("[pairing-codes] node registration failed for node %s: %v", req.NodeID, err)
			respondError(w, http.StatusInternalServerError, "failed to register node")
			return
		}
		if outcome != nodeRegistrationOK {
			respondError(w, http.StatusConflict, outcome.errorReason())
			return
		}

		// Persist which node consumed the code (auditability). Done after the
		// node row exists so the FK is satisfied; the consumed row is retained.
		if _, err := tx.Exec(r.Context(),
			`UPDATE pairing_codes SET node_id = $2 WHERE code_hash = $1`,
			codeHash, req.NodeID,
		); err != nil {
			log.Printf("[pairing-codes] failed to record consuming node %s: %v", req.NodeID, err)
			respondError(w, http.StatusInternalServerError, "failed to register node")
			return
		}

		if err := tx.Commit(r.Context()); err != nil {
			log.Printf("[pairing-codes] commit failed for node %s: %v", req.NodeID, err)
			respondError(w, http.StatusInternalServerError, "failed to register node")
			return
		}

		respondJSON(w, http.StatusOK, map[string]interface{}{
			"status":     "ok",
			"account_id": accountID,
			"is_primary": node.IsPrimary,
		})
	}
}
