package handler

import (
	"encoding/hex"
	"errors"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"

	"github.com/TalibMushtaq/nodus/services/relay/internal/auth"
	"github.com/TalibMushtaq/nodus/services/relay/internal/buffer"
	"github.com/TalibMushtaq/nodus/services/relay/internal/db"
	"github.com/TalibMushtaq/nodus/services/relay/internal/hub"
	"github.com/TalibMushtaq/nodus/services/relay/internal/rdb"
	"github.com/google/uuid"
)

// maxBufferUploadSize caps a single shard upload. Shards are 8 MB (Phase 2);
// the extra headroom accommodates transport framing without inviting abuse.
const maxBufferUploadSize = 10 * 1024 * 1024

// uploadMetadata is the parsed X-Nodus metadata header block for a shard upload.
type uploadMetadata struct {
	FileID        string
	VersionNumber int
	ShardIndex    int
	Hash          string
	Size          int64
	TransferID    string
	TargetNode    string
	SourceDevice  string
}

// parseUploadMetadata reads the shard metadata from X-Nodus headers. Every
// field is required except source_device, which can be empty for v1 clients
// that haven't registered a device identity yet.
func parseUploadMetadata(r *http.Request) (uploadMetadata, error) {
	md := uploadMetadata{
		FileID:       strings.TrimSpace(r.Header.Get("X-Nodus-File-ID")),
		Hash:         strings.TrimSpace(r.Header.Get("X-Nodus-Hash")),
		TransferID:   strings.TrimSpace(r.Header.Get("X-Nodus-Transfer-ID")),
		TargetNode:   strings.TrimSpace(r.Header.Get("X-Nodus-Target-Node")),
		SourceDevice: strings.TrimSpace(r.Header.Get("X-Nodus-Source-Device")),
	}
	version, err := strconv.Atoi(strings.TrimSpace(r.Header.Get("X-Nodus-Version-Number")))
	if err != nil {
		return md, errInvalidUploadMeta("version_number must be a positive integer")
	}
	if version < 1 {
		return md, errInvalidUploadMeta("version_number must be >= 1")
	}
	shard, err := strconv.Atoi(strings.TrimSpace(r.Header.Get("X-Nodus-Shard-Index")))
	if err != nil || shard < 0 {
		return md, errInvalidUploadMeta("shard_index must be a non-negative integer")
	}
	size, err := strconv.ParseInt(strings.TrimSpace(r.Header.Get("X-Nodus-Size")), 10, 64)
	if err != nil || size < 0 || size > maxBufferUploadSize {
		return md, errInvalidUploadMeta("size must be between 0 and 10MB")
	}
	md.VersionNumber = version
	md.ShardIndex = shard
	md.Size = size

	switch {
	case md.FileID == "":
		return md, errInvalidUploadMeta("X-Nodus-File-ID is required")
	case md.Hash == "":
		return md, errInvalidUploadMeta("X-Nodus-Hash is required")
	case md.TargetNode == "":
		return md, errInvalidUploadMeta("X-Nodus-Target-Node is required")
	}
	return md, nil
}

// errInvalidUploadMeta wraps a validation message so callers can match the
// exact reason without string matching.
func errInvalidUploadMeta(msg string) error {
	return errors.New(msg)
}

// BufferUpload handles POST /buffer/upload — a client pushing an encrypted
// shard into the Relay's temporary buffer when the target Storage Node is
// offline (Path C, §13). Metadata travels in X-Nodus headers; the body is
// the raw encrypted bytes. On success the Relay records the shard as
// RELAY_BUFFERED and, if the target node is online right now, proactively
// sends pending_notify so delivery doesn't wait for the next reconnect.
func BufferUpload(pool *db.Pool, rClient *rdb.Client, buf *buffer.Buffer, h *hub.Hub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		accountID, ok := auth.GetAccountID(r.Context())
		if !ok {
			respondError(w, http.StatusUnauthorized, "unauthorized")
			return
		}

		md, err := parseUploadMetadata(r)
		if err != nil {
			respondError(w, http.StatusBadRequest, err.Error())
			return
		}

		// The target node must belong to the account, otherwise a client could
		// fill another tenant's buffer using well-known node IDs.
		var nodeOwned bool
		if err := pool.QueryRow(r.Context(),
			`SELECT EXISTS(SELECT 1 FROM storage_nodes WHERE node_id=$1 AND account_id=$2)`,
			md.TargetNode, accountID).Scan(&nodeOwned); err != nil {
			respondError(w, http.StatusInternalServerError, "failed to check storage node")
			return
		}
		if !nodeOwned {
			respondError(w, http.StatusNotFound, "target node not found for this account")
			return
		}

		// file_locations FK's to file_versions, so the version must already be
		// visible to the Relay. Clients emit FILE_CREATED / FILE_VERSION_ADDED
		// sync events before uploading shards. The version must also belong to
		// this account — otherwise a client could reference another tenant's
		// (file_id, version_number) and pollute its own node's shard metadata
		// with foreign rows.
		var versionExists bool
		if err := pool.QueryRow(r.Context(),
			`SELECT EXISTS(SELECT 1 FROM file_versions fv
			  JOIN files f ON f.file_id = fv.file_id
			  WHERE fv.file_id=$1 AND fv.version_number=$2 AND f.account_id=$3)`,
			md.FileID, md.VersionNumber, accountID).Scan(&versionExists); err != nil {
			respondError(w, http.StatusInternalServerError, "failed to check file version")
			return
		}
		if !versionExists {
			respondError(w, http.StatusNotFound, "file version not found; ensure sync events are processed first")
			return
		}

		// Drop any buffer file from a previous upload of this shard before we
		// re-arm the row, so retries don't leak orphaned files.
		var staleBufferID *string
		_ = pool.QueryRow(r.Context(),
			`SELECT buffer_id FROM file_locations WHERE file_id=$1 AND version_number=$2 AND shard_index=$3 AND node_id=$4`,
			md.FileID, md.VersionNumber, md.ShardIndex, md.TargetNode).Scan(&staleBufferID)
		if staleBufferID != nil && *staleBufferID != "" {
			_ = buf.Delete(*staleBufferID)
		}

		// Reserve the shard as UPLOADING so a crashed request leaves a swept
		// mark rather than a silent hole.
		if _, err := pool.Exec(r.Context(), `
			INSERT INTO file_locations (file_id, version_number, shard_index, node_id, status, buffer_id, hash, size_bytes, source_device)
			VALUES ($1, $2, $3, $4, 'UPLOADING', NULL, $5, $6, $7)
			ON CONFLICT (file_id, version_number, shard_index, node_id) DO UPDATE SET
				status = 'UPLOADING',
				buffer_id = NULL,
				hash = excluded.hash,
				size_bytes = excluded.size_bytes,
				source_device = excluded.source_device,
				updated_at = NOW()
		`, md.FileID, md.VersionNumber, md.ShardIndex, md.TargetNode, md.Hash, md.Size, md.SourceDevice); err != nil {
			respondError(w, http.StatusInternalServerError, "failed to record upload")
			return
		}

		// Content-Length is unreliable for chunked encoding, so we cap with
		// MaxBytesReader and validate length against the declared size.
		r.Body = http.MaxBytesReader(w, r.Body, maxBufferUploadSize+1)
		body, err := io.ReadAll(r.Body)
		if len(body) != int(md.Size) {
			_, _ = pool.Exec(r.Context(),
				`DELETE FROM file_locations WHERE file_id=$1 AND version_number=$2 AND shard_index=$3 AND node_id=$4`,
				md.FileID, md.VersionNumber, md.ShardIndex, md.TargetNode)
			respondError(w, http.StatusBadRequest, "body length does not match declared size")
			return
		}
		if err != nil {
			_, _ = pool.Exec(r.Context(),
				`DELETE FROM file_locations WHERE file_id=$1 AND version_number=$2 AND shard_index=$3 AND node_id=$4`,
				md.FileID, md.VersionNumber, md.ShardIndex, md.TargetNode)
			respondError(w, http.StatusBadRequest, "failed to read request body")
			return
		}

		// Verify the integrity digest before anything hits the buffer: a wrong
		// hash means the client or the wire corrupted the payload.
		hasher := blake3Hasher()
		_, _ = hasher.Write(body)
		actualHash := hex.EncodeToString(hasher.Sum(nil))
		if actualHash != md.Hash {
			_, _ = pool.Exec(r.Context(),
				`DELETE FROM file_locations WHERE file_id=$1 AND version_number=$2 AND shard_index=$3 AND node_id=$4`,
				md.FileID, md.VersionNumber, md.ShardIndex, md.TargetNode)
			respondError(w, http.StatusBadRequest, "hash mismatch: received "+actualHash)
			return
		}

		bufferID := uuid.NewString()
		if err := buf.Store(bufferID, body); err != nil {
			_, _ = pool.Exec(r.Context(),
				`DELETE FROM file_locations WHERE file_id=$1 AND version_number=$2 AND shard_index=$3 AND node_id=$4`,
				md.FileID, md.VersionNumber, md.ShardIndex, md.TargetNode)
			respondError(w, http.StatusInternalServerError, "failed to store shard in buffer")
			return
		}

		// Commit the row to RELAY_BUFFERED and publish the Redis pending entry
		// so reconnect-time delivery can find it even if we crash now.
		if _, err := pool.Exec(r.Context(), `
			UPDATE file_locations
			SET status='RELAY_BUFFERED', buffer_id=$1, updated_at=NOW()
			WHERE file_id=$2 AND version_number=$3 AND shard_index=$4 AND node_id=$5
		`, bufferID, md.FileID, md.VersionNumber, md.ShardIndex, md.TargetNode); err != nil {
			_ = buf.Delete(bufferID)
			respondError(w, http.StatusInternalServerError, "failed to finalize upload")
			return
		}
		if rClient != nil {
			_ = rClient.AddPendingBuffer(r.Context(), md.TargetNode, bufferID)
		}

		// Proactive delivery: if the target node is connected right now, don't
		// make it wait for the next reconnect.
		notifySent := false
		if h != nil {
			envBytes, ok := buildPendingNotifyEnvelope(r.Context(), rClient,
				PendingNotifyPayload{
					FileID:        md.FileID,
					VersionNumber: md.VersionNumber,
					ShardIndex:    md.ShardIndex,
					BufferID:      bufferID,
					FromDevice:    md.SourceDevice,
					Hash:          md.Hash,
					Size:          md.Size,
				})
			if ok {
				notifySent = h.SendToNode(md.TargetNode, envBytes)
			}
		}
		if notifySent {
			log.Printf("[buffer-upload] shard %s:%d:%d buffered (buffer=%s) and notified node=%s",
				md.FileID, md.VersionNumber, md.ShardIndex, bufferID, md.TargetNode)
		} else {
			log.Printf("[buffer-upload] shard %s:%d:%d buffered (buffer=%s) for node=%s (node offline; will notify on reconnect)",
				md.FileID, md.VersionNumber, md.ShardIndex, bufferID, md.TargetNode)
		}

		respondJSON(w, http.StatusCreated, map[string]any{
			"buffer_id": bufferID,
			"status":    "RELAY_BUFFERED",
		})
	}
}
