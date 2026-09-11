package handler

import (
	"log"
	"net/http"
	"time"

	"github.com/TalibMushtaq/nodus/services/relay/internal/auth"
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
