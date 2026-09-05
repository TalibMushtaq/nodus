package handler

import (
	"log"
	"net/http"
	"strconv"

	"github.com/TalibMushtaq/nodus/services/relay/internal/buffer"
	"github.com/TalibMushtaq/nodus/services/relay/internal/db"
	"github.com/TalibMushtaq/nodus/services/relay/internal/rdb"
)

// BufferFetch handles GET /buffer/fetch?token=... — a Storage Node pulling a
// buffered shard's bytes over HTTP (Path C, §13). This endpoint is NOT behind
// JWT auth: the node authenticates via the WS challenge handshake, and the
// single-use fetch token (Redis GETDEL, 10-min TTL) is the request credential.
// Serving a fetch transitions the shard from RELAY_BUFFERED to NODE_RECEIVING;
// the node subsequently acks "verified" or "failed" over WebSocket.
func BufferFetch(pool *db.Pool, rClient *rdb.Client, buf *buffer.Buffer) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if rClient == nil {
			respondError(w, http.StatusServiceUnavailable, "fetch tokens unavailable")
			return
		}
		token := r.URL.Query().Get("token")
		if token == "" {
			respondError(w, http.StatusBadRequest, "missing token query parameter")
			return
		}

		// Atomic single-use check: GETDEL removes the key so a replayed token
		// is rejected on the second use.
		bufferID, err := rClient.ConsumeFetchToken(r.Context(), token)
		if err != nil {
			respondError(w, http.StatusInternalServerError, "failed to validate token")
			return
		}
		if bufferID == "" {
			respondError(w, http.StatusUnauthorized, "invalid or expired fetch token")
			return
		}

		// Read the bytes BEFORE marking NODE_RECEIVING so a broken buffer file
		// doesn't strand the shard in a receiving state no one can deliver.
		data, err := buf.Fetch(bufferID)
		if err != nil {
			log.Printf("[buffer-fetch] buffer=%s missing; node will be re-notified on reconnect: %v", bufferID, err)
			respondError(w, http.StatusNotFound, "buffered shard no longer available")
			return
		}

		var (
			fileID        string
			versionNumber int64
			shardIndex    int
			hash          string
			status        string
		)
		err = pool.QueryRow(r.Context(), `
			SELECT file_id, version_number, shard_index, hash, status
			FROM file_locations
			WHERE buffer_id = $1
		`, bufferID).Scan(&fileID, &versionNumber, &shardIndex, &hash, &status)
		if err != nil {
			respondError(w, http.StatusNotFound, "unknown buffer id")
			return
		}
		if status != "RELAY_BUFFERED" {
			// Already being delivered or stored; a competing fetch raced us.
			respondError(w, http.StatusConflict, "shard is no longer awaiting delivery")
			return
		}

		// From here the node is taking custody: transition to NODE_RECEIVING so
		// the file state machine reflects the in-flight transfer.
		if _, err := pool.Exec(r.Context(), `
			UPDATE file_locations SET status='NODE_RECEIVING', updated_at=NOW()
			WHERE buffer_id=$1 AND status='RELAY_BUFFERED'
		`, bufferID); err != nil {
			respondError(w, http.StatusInternalServerError, "failed to transition shard state")
			return
		}

		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Length", strconv.Itoa(len(data)))
		w.Header().Set("X-Nodus-File-ID", fileID)
		w.Header().Set("X-Nodus-Version-Number", strconv.FormatInt(versionNumber, 10))
		w.Header().Set("X-Nodus-Shard-Index", strconv.Itoa(shardIndex))
		w.Header().Set("X-Nodus-Hash", hash)
		w.WriteHeader(http.StatusOK)
		if _, err := w.Write(data); err != nil {
			log.Printf("[buffer-fetch] write error for buffer=%s: %v", bufferID, err)
		}
		log.Printf("[buffer-fetch] served buffer=%s (file=%s:%d:%d) -> NODE_RECEIVING", bufferID, fileID, versionNumber, shardIndex)
	}
}
