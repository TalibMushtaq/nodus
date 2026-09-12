package handler

import (
	"context"
	"net/http"
	"time"

	"github.com/TalibMushtaq/nodus/services/relay/internal/auth"
	"github.com/TalibMushtaq/nodus/services/relay/internal/db"
)

// FolderResponse is one folder row for the client catalog.
type FolderResponse struct {
	FolderID       string    `json:"folder_id"`
	ParentFolderID *string   `json:"parent_folder_id"`
	EncryptedName  *string   `json:"encrypted_name"`
	CreatedAt      time.Time `json:"created_at"`
	UpdatedAt      time.Time `json:"updated_at"`
}

// ListFolders returns the account's folder tree (Phase 14 F1). Folder names are
// opaque here; the client decrypts them with its FEK.
func ListFolders(pool *db.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		accountID, ok := auth.GetAccountID(r.Context())
		if !ok {
			respondError(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		folders, err := queryFolders(r.Context(), pool, accountID)
		if err != nil {
			respondError(w, http.StatusInternalServerError, "failed to query folders")
			return
		}
		respondJSON(w, http.StatusOK, folders)
	}
}

func queryFolders(ctx context.Context, pool *db.Pool, accountID string) ([]FolderResponse, error) {
	rows, err := pool.Query(ctx, `
		SELECT folder_id, parent_folder_id, encrypted_name, created_at, updated_at
		FROM folders
		WHERE account_id = $1
		ORDER BY created_at ASC
	`, accountID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	folders := make([]FolderResponse, 0)
	for rows.Next() {
		var folder FolderResponse
		if err := rows.Scan(&folder.FolderID, &folder.ParentFolderID, &folder.EncryptedName, &folder.CreatedAt, &folder.UpdatedAt); err != nil {
			return nil, err
		}
		folders = append(folders, folder)
	}
	return folders, rows.Err()
}
