package handler

import (
	"net/http"

	"github.com/TalibMushtaq/nodus/services/relay/internal/auth"
	"github.com/TalibMushtaq/nodus/services/relay/internal/db"
	"github.com/jackc/pgx/v5"
)

// KeyEnvelopeResponse is one opaque FEK envelope for a recipient.
type KeyEnvelopeResponse struct {
	FileID        string `json:"file_id"`
	RecipientID   string `json:"recipient_id"`
	RecipientKind string `json:"recipient_kind"`
	EncryptedKey  string `json:"encrypted_key"`
}

// FolderKeyEnvelopeResponse is one opaque folder-key envelope for a recipient.
type FolderKeyEnvelopeResponse struct {
	FolderID      string `json:"folder_id"`
	RecipientID   string `json:"recipient_id"`
	RecipientKind string `json:"recipient_kind"`
	EncryptedKey  string `json:"encrypted_key"`
}

// ListEnvelopes returns the account's key envelopes for one file or folder
// (§25). The Relay never sees the key; a device picks the envelope whose
// recipient_id matches its own id and opens it with its derived X25519 key.
// Exactly one of file_id / folder_id is required.
func ListEnvelopes(pool *db.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		accountID, ok := auth.GetAccountID(r.Context())
		if !ok {
			respondError(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		fileID := r.URL.Query().Get("file_id")
		folderID := r.URL.Query().Get("folder_id")
		if fileID == "" && folderID == "" {
			respondError(w, http.StatusBadRequest, "file_id or folder_id is required")
			return
		}

		if fileID != "" {
			listFileEnvelopes(w, r, pool, accountID, fileID)
			return
		}
		// Join through folders so one account can never read another's envelopes
		// even if it guesses a folder_id.
		rows, err := pool.Query(r.Context(), `
			SELECT fe.folder_id, fe.recipient_id, fe.recipient_kind, fe.encrypted_key
			FROM folder_key_envelopes fe
			JOIN folders f ON f.folder_id = fe.folder_id
			WHERE fe.folder_id = $1 AND f.account_id = $2
			ORDER BY fe.recipient_id ASC
		`, folderID, accountID)
		if err != nil {
			respondError(w, http.StatusInternalServerError, "failed to query folder key envelopes")
			return
		}
		defer rows.Close()
		respondFolderEnvelopes(w, rows)
	}
}

func listFileEnvelopes(w http.ResponseWriter, r *http.Request, pool *db.Pool, accountID, fileID string) {
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

// ListFolderEnvelopes returns every folder-key envelope for the account in one
// request. The client needs all of them to decrypt the folder tree for display;
// fetching per-folder would be an N+1 round trip per refresh.
func ListFolderEnvelopes(pool *db.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		accountID, ok := auth.GetAccountID(r.Context())
		if !ok {
			respondError(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		rows, err := pool.Query(r.Context(), `
			SELECT fe.folder_id, fe.recipient_id, fe.recipient_kind, fe.encrypted_key
			FROM folder_key_envelopes fe
			JOIN folders f ON f.folder_id = fe.folder_id
			WHERE f.account_id = $1
			ORDER BY fe.folder_id ASC, fe.recipient_id ASC
		`, accountID)
		if err != nil {
			respondError(w, http.StatusInternalServerError, "failed to query folder key envelopes")
			return
		}
		defer rows.Close()
		respondFolderEnvelopes(w, rows)
	}
}

func respondFolderEnvelopes(w http.ResponseWriter, rows pgx.Rows) {
	envelopes := make([]FolderKeyEnvelopeResponse, 0)
	for rows.Next() {
		var env FolderKeyEnvelopeResponse
		if err := rows.Scan(&env.FolderID, &env.RecipientID, &env.RecipientKind, &env.EncryptedKey); err != nil {
			respondError(w, http.StatusInternalServerError, "failed to scan folder key envelope")
			return
		}
		envelopes = append(envelopes, env)
	}
	respondJSON(w, http.StatusOK, envelopes)
}
