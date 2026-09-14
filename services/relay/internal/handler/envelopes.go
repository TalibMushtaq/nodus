package handler

import (
	"net/http"
	"time"

	"github.com/TalibMushtaq/nodus/services/relay/internal/auth"
	"github.com/TalibMushtaq/nodus/services/relay/internal/db"
	"github.com/jackc/pgx/v5"
)

// validRecipientKind reports whether an envelope's recipient_kind is one the
// Relay recognizes. `recovery` is the account-level identity derived from the
// user's offline phrase (ADR-0002); device and node are the connected peers.
func validRecipientKind(kind string) bool {
	return kind == "device" || kind == "node" || kind == "recovery"
}

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

// EnvelopeSummaryResponse is one recipient's envelope coverage for the Security
// page's "Key envelopes" table. It carries no ciphertext, so listing coverage is
// cheap even for an account with many files.
type EnvelopeSummaryResponse struct {
	RecipientID   string     `json:"recipient_id"`
	RecipientKind string     `json:"recipient_kind"`
	FileCount     int        `json:"file_count"`
	FolderCount   int        `json:"folder_count"`
	LastUpdated   *time.Time `json:"last_updated"`
}

// EnvelopeSummary returns, per recipient, how many file and folder keys it holds
// an envelope for and when its newest envelope was written. The UNION rolls file
// and folder envelopes into one row per recipient; the outer GROUP BY merges a
// recipient that appears in both tables. Account scoping happens in each branch
// (join through files/folders) so one account can never read another's coverage.
func EnvelopeSummary(pool *db.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		accountID, ok := auth.GetAccountID(r.Context())
		if !ok {
			respondError(w, http.StatusUnauthorized, "unauthorized")
			return
		}

		rows, err := pool.Query(r.Context(), `
			SELECT recipient_id, recipient_kind,
			       SUM(file_count) AS file_count,
			       SUM(folder_count) AS folder_count,
			       MAX(last_updated) AS last_updated
			FROM (
				SELECT ke.recipient_id, ke.recipient_kind,
				       COUNT(DISTINCT ke.file_id) AS file_count, 0 AS folder_count,
				       MAX(ke.created_at) AS last_updated
				FROM key_envelopes ke
				JOIN files f ON f.file_id = ke.file_id
				WHERE f.account_id = $1
				GROUP BY ke.recipient_id, ke.recipient_kind
				UNION ALL
				SELECT fe.recipient_id, fe.recipient_kind,
				       0 AS file_count, COUNT(DISTINCT fe.folder_id) AS folder_count,
				       MAX(fe.created_at) AS last_updated
				FROM folder_key_envelopes fe
				JOIN folders fo ON fo.folder_id = fe.folder_id
				WHERE fo.account_id = $1
				GROUP BY fe.recipient_id, fe.recipient_kind
			) per_recipient
			GROUP BY recipient_id, recipient_kind
			ORDER BY recipient_kind ASC, recipient_id ASC
		`, accountID)
		if err != nil {
			respondError(w, http.StatusInternalServerError, "failed to summarize key envelopes")
			return
		}
		defer rows.Close()

		summaries := make([]EnvelopeSummaryResponse, 0)
		for rows.Next() {
			var s EnvelopeSummaryResponse
			if err := rows.Scan(&s.RecipientID, &s.RecipientKind, &s.FileCount, &s.FolderCount, &s.LastUpdated); err != nil {
				respondError(w, http.StatusInternalServerError, "failed to scan envelope summary")
				return
			}
			summaries = append(summaries, s)
		}
		respondJSON(w, http.StatusOK, summaries)
	}
}

// EnvelopeExportResponse is the account's complete set of opaque envelopes for
// the Security page's "download encrypted backup" action. The Relay cannot
// decrypt any of it, so the download is a ciphertext-only backup.
type EnvelopeExportResponse struct {
	AccountID       string                      `json:"account_id"`
	GeneratedAt     time.Time                   `json:"generated_at"`
	FileEnvelopes   []KeyEnvelopeResponse       `json:"file_envelopes"`
	FolderEnvelopes []FolderKeyEnvelopeResponse `json:"folder_envelopes"`
}

// ExportEnvelopes returns every file and folder envelope for the account so the
// user can keep an offline copy. The account id and timestamp frame the export
// so a later restore can verify what it is looking at.
func ExportEnvelopes(pool *db.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		accountID, ok := auth.GetAccountID(r.Context())
		if !ok {
			respondError(w, http.StatusUnauthorized, "unauthorized")
			return
		}

		fileRows, err := pool.Query(r.Context(), `
			SELECT ke.file_id, ke.recipient_id, ke.recipient_kind, ke.encrypted_key
			FROM key_envelopes ke
			JOIN files f ON f.file_id = ke.file_id
			WHERE f.account_id = $1
			ORDER BY ke.file_id ASC, ke.recipient_id ASC
		`, accountID)
		if err != nil {
			respondError(w, http.StatusInternalServerError, "failed to query key envelopes")
			return
		}
		defer fileRows.Close()

		fileEnvelopes := make([]KeyEnvelopeResponse, 0)
		for fileRows.Next() {
			var env KeyEnvelopeResponse
			if err := fileRows.Scan(&env.FileID, &env.RecipientID, &env.RecipientKind, &env.EncryptedKey); err != nil {
				respondError(w, http.StatusInternalServerError, "failed to scan key envelope")
				return
			}
			fileEnvelopes = append(fileEnvelopes, env)
		}

		folderRows, err := pool.Query(r.Context(), `
			SELECT fe.folder_id, fe.recipient_id, fe.recipient_kind, fe.encrypted_key
			FROM folder_key_envelopes fe
			JOIN folders fo ON fo.folder_id = fe.folder_id
			WHERE fo.account_id = $1
			ORDER BY fe.folder_id ASC, fe.recipient_id ASC
		`, accountID)
		if err != nil {
			respondError(w, http.StatusInternalServerError, "failed to query folder key envelopes")
			return
		}
		defer folderRows.Close()

		folderEnvelopes := make([]FolderKeyEnvelopeResponse, 0)
		for folderRows.Next() {
			var env FolderKeyEnvelopeResponse
			if err := folderRows.Scan(&env.FolderID, &env.RecipientID, &env.RecipientKind, &env.EncryptedKey); err != nil {
				respondError(w, http.StatusInternalServerError, "failed to scan folder key envelope")
				return
			}
			folderEnvelopes = append(folderEnvelopes, env)
		}

		respondJSON(w, http.StatusOK, EnvelopeExportResponse{
			AccountID:       accountID,
			GeneratedAt:     time.Now().UTC(),
			FileEnvelopes:   fileEnvelopes,
			FolderEnvelopes: folderEnvelopes,
		})
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
