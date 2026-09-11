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

		// Upsert the node under the code's issuing account. The is_primary
		// rule: first node for an account gets is_primary = true;
		// re-registration leaves it untouched. A node belonging to another
		// account is rejected (no row updated → ErrNoRows → rollback), so the
		// code stays PENDING for retry with a different node_id.
		var isPrimary bool
		err = tx.QueryRow(r.Context(),
			`INSERT INTO storage_nodes (node_id, account_id, public_key, capabilities, status, is_primary)
			 VALUES ($1, $2, $3, $4::jsonb, 'ACTIVE',
			         NOT EXISTS (SELECT 1 FROM storage_nodes WHERE account_id = $2))
			 ON CONFLICT (node_id) DO UPDATE SET
			     public_key = excluded.public_key,
			     capabilities = excluded.capabilities,
			     status = 'ACTIVE'
			     WHERE storage_nodes.account_id = excluded.account_id
			 RETURNING is_primary`,
			req.NodeID, accountID, req.PublicKey, defaultNodeCapabilities,
		).Scan(&isPrimary)

		if errors.Is(err, pgx.ErrNoRows) {
			respondError(w, http.StatusConflict, "node_owned_elsewhere")
			return
		}
		if err != nil {
			log.Printf("[pairing-codes] node upsert failed for node %s: %v", req.NodeID, err)
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
			"is_primary": isPrimary,
		})
	}
}
