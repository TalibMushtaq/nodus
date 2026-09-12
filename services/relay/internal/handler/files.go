package handler

import (
	"net/http"
	"time"

	"github.com/TalibMushtaq/nodus/services/relay/internal/auth"
	"github.com/TalibMushtaq/nodus/services/relay/internal/db"
)

// FileVersionResponse is one file_versions row.
type FileVersionResponse struct {
	VersionNumber  int       `json:"version_number"`
	ShardCount     int       `json:"shard_count"`
	VersionHash    string    `json:"version_hash"`
	ConflictStatus string    `json:"conflict_status"`
	CreatedAt      time.Time `json:"created_at"`
}

// FileLocationResponse is one file_locations row (a shard on a node). `hash`
// and `size_bytes` are the ciphertext BLAKE3/size the uploader declared; the
// download path verifies fetched bytes against `hash` before decrypting.
type FileLocationResponse struct {
	VersionNumber int     `json:"version_number"`
	ShardIndex    int     `json:"shard_index"`
	NodeID        string  `json:"node_id"`
	Status        string  `json:"status"`
	Hash          *string `json:"hash"`
	SizeBytes     *int64  `json:"size_bytes"`
}

// FileResponse is a file with its versions and current shard locations. This
// is the read path that populates the web client's cached catalog (Phase 14);
// without it the browser could create files but never list them.
type FileResponse struct {
	FileID         string                 `json:"file_id"`
	ParentFolderID *string                `json:"parent_folder_id"`
	EncryptedName  *string                `json:"encrypted_name"`
	CreatedAt      time.Time              `json:"created_at"`
	UpdatedAt      time.Time              `json:"updated_at"`
	Versions       []FileVersionResponse  `json:"versions"`
	Locations      []FileLocationResponse `json:"locations"`
}

// ListFiles returns every file owned by the account, with versions and shard
// locations, for the client-side catalog. Three flat queries are assembled in
// Go rather than a join to keep the response shape stable and avoid row
// multiplication across versions × locations.
func ListFiles(pool *db.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		accountID, ok := auth.GetAccountID(r.Context())
		if !ok {
			respondError(w, http.StatusUnauthorized, "unauthorized")
			return
		}

		files := make([]FileResponse, 0)
		byID := make(map[string]*FileResponse)

		fileRows, err := pool.Query(r.Context(), `
			SELECT file_id, parent_folder_id, encrypted_name, created_at, updated_at
			FROM files
			WHERE account_id = $1
			ORDER BY created_at DESC
		`, accountID)
		if err != nil {
			respondError(w, http.StatusInternalServerError, "failed to query files")
			return
		}
		for fileRows.Next() {
			var file FileResponse
			if err := fileRows.Scan(&file.FileID, &file.ParentFolderID, &file.EncryptedName, &file.CreatedAt, &file.UpdatedAt); err != nil {
				fileRows.Close()
				respondError(w, http.StatusInternalServerError, "failed to scan file")
				return
			}
			file.Versions = make([]FileVersionResponse, 0)
			file.Locations = make([]FileLocationResponse, 0)
			files = append(files, file)
		}
		fileRows.Close()
		if err := fileRows.Err(); err != nil {
			respondError(w, http.StatusInternalServerError, "failed to read files")
			return
		}
		for i := range files {
			byID[files[i].FileID] = &files[i]
		}
		if len(files) == 0 {
			respondJSON(w, http.StatusOK, files)
			return
		}

		versionRows, err := pool.Query(r.Context(), `
			SELECT fv.file_id, fv.version_number, fv.shard_count, fv.version_hash, fv.conflict_status, fv.created_at
			FROM file_versions fv
			JOIN files f ON f.file_id = fv.file_id
			WHERE f.account_id = $1
			ORDER BY fv.version_number ASC
		`, accountID)
		if err != nil {
			respondError(w, http.StatusInternalServerError, "failed to query file versions")
			return
		}
		for versionRows.Next() {
			var (
				fileID  string
				version FileVersionResponse
			)
			if err := versionRows.Scan(&fileID, &version.VersionNumber, &version.ShardCount, &version.VersionHash, &version.ConflictStatus, &version.CreatedAt); err != nil {
				versionRows.Close()
				respondError(w, http.StatusInternalServerError, "failed to scan file version")
				return
			}
			if file, ok := byID[fileID]; ok {
				file.Versions = append(file.Versions, version)
			}
		}
		versionRows.Close()
		if err := versionRows.Err(); err != nil {
			respondError(w, http.StatusInternalServerError, "failed to read file versions")
			return
		}

		locationRows, err := pool.Query(r.Context(), `
			SELECT fl.file_id, fl.version_number, fl.shard_index, fl.node_id, fl.status, fl.hash, fl.size_bytes
			FROM file_locations fl
			JOIN files f ON f.file_id = fl.file_id
			WHERE f.account_id = $1
			ORDER BY fl.version_number ASC, fl.shard_index ASC
		`, accountID)
		if err != nil {
			respondError(w, http.StatusInternalServerError, "failed to query file locations")
			return
		}
		for locationRows.Next() {
			var (
				fileID   string
				location FileLocationResponse
			)
			if err := locationRows.Scan(&fileID, &location.VersionNumber, &location.ShardIndex, &location.NodeID, &location.Status, &location.Hash, &location.SizeBytes); err != nil {
				locationRows.Close()
				respondError(w, http.StatusInternalServerError, "failed to scan file location")
				return
			}
			if file, ok := byID[fileID]; ok {
				file.Locations = append(file.Locations, location)
			}
		}
		locationRows.Close()
		if err := locationRows.Err(); err != nil {
			respondError(w, http.StatusInternalServerError, "failed to read file locations")
			return
		}

		respondJSON(w, http.StatusOK, files)
	}
}
