package handler

import (
	"net/http"

	"github.com/TalibMushtaq/nodus/services/relay/internal/auth"
	"github.com/TalibMushtaq/nodus/services/relay/internal/db"
)

// KeyEnvelopeResponse is one opaque FEK envelope for a recipient.
type KeyEnvelopeResponse struct {
	FileID        string `json:"file_id"`
	RecipientID   string `json:"recipient_id"`
	RecipientKind string `json:"recipient_kind"`
	EncryptedKey  string `json:"encrypted_key"`
}

// ListEnvelopes returns the account's key envelopes for one file (§25). The
// Relay never sees the FEK; a device picks the envelope whose recipient_id
// matches its own id and opens it with its derived X25519 key.
func ListEnvelopes(pool *db.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		accountID, ok := auth.GetAccountID(r.Context())
		if !ok {
			respondError(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		fileID := r.URL.Query().Get("file_id")
		if fileID == "" {
			respondError(w, http.StatusBadRequest, "file_id is required")
			return
		}

		// Join through files so one account can never read another's envelopes
		// even if it guesses a file_id.
		rows, err := pool.Query(r.Context(), `
			SELECT ke.file_id, ke.recipient_id, ke.recipient_kind, ke.encrypted_key
			FROM key_envelopes ke
			JOIN files f ON f.file_id = ke.file_id
			WHERE ke.file_id = $1 AND f.account_id = $2
			ORDER BY ke.recipient_id ASC
		`, fileID, accountID)
		if err != nil {
			respondError(w, http.StatusInternalServerError, "failed to query key envelopes")
			return
		}
		defer rows.Close()

		envelopes := make([]KeyEnvelopeResponse, 0)
		for rows.Next() {
			var env KeyEnvelopeResponse
			if err := rows.Scan(&env.FileID, &env.RecipientID, &env.RecipientKind, &env.EncryptedKey); err != nil {
				respondError(w, http.StatusInternalServerError, "failed to scan key envelope")
				return
			}
			envelopes = append(envelopes, env)
		}
		respondJSON(w, http.StatusOK, envelopes)
	}
}
