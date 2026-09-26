package handler

import (
	"log"
	"net/http"
	"strconv"
	"strings"

	"github.com/TalibMushtaq/nodus/services/relay/internal/auth"
	"github.com/TalibMushtaq/nodus/services/relay/internal/buffer"
	"github.com/TalibMushtaq/nodus/services/relay/internal/db"
	"github.com/TalibMushtaq/nodus/services/relay/internal/rdb"
)

// BufferFetch handles GET /buffer/fetch — a Storage Node pulling a buffered
// shard's bytes over HTTP (Path C, §13). This endpoint is not behind session
// auth, because a node has no session; it is behind auth.RequireNodeAuth, which
// checks the node's stateless Ed25519 request signature (the same credential
// GET /node/shards/{object_id} uses). RequireNodeAuth puts the authenticated
// node_id in the request context, which is what the token is checked against.
//
// Two things are therefore required, and neither is sufficient alone: a
// single-use token (Redis GETDEL, 10-min TTL) that scopes the request to one
// buffered shard, presented as `Authorization: Bearer <token>`, and a signature
// proving which node is asking. The token alone used to be the whole credential,
// which meant any holder of a leaked token could redeem a shard meant for
// someone else and move it to NODE_RECEIVING.
//
// The token used to travel in the query string, which makes it a credential in
// every access log, proxy log and Referer header between the node and here —
// and enabling access logging on the bundled Caddy is one `log` directive away.
// A header is also what proxies redact by default, which is most of the value.
// The query parameter is now rejected rather than ignored, so a node that has
// not upgraded is told what to change instead of seeing a bare 401.
func BufferFetch(pool *db.Pool, rClient *rdb.Client, buf *buffer.Buffer) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if rClient == nil {
			respondError(w, http.StatusServiceUnavailable, "fetch tokens unavailable")
			return
		}
		if r.URL.Query().Get("token") != "" {
			respondError(w, http.StatusBadRequest,
				"send the fetch token as 'Authorization: Bearer <token>', not as a query parameter")
			return
		}
		token := ""
		if header := r.Header.Get("Authorization"); strings.HasPrefix(header, "Bearer ") {
			token = strings.TrimSpace(strings.TrimPrefix(header, "Bearer "))
		}
		if token == "" {
			respondError(w, http.StatusUnauthorized, "missing bearer fetch token")
			return
		}

		// Atomic single-use check: GETDEL removes the key so a replayed token
		// is rejected on the second use.
		tokenNodeID, bufferID, found, err := rClient.ConsumeFetchToken(r.Context(), token)
		if err != nil {
			respondError(w, http.StatusInternalServerError, "failed to validate token")
			return
		}
		if !found {
			respondError(w, http.StatusUnauthorized, "invalid or expired fetch token")
			return
		}

		// The token is bound to the node the shard was routed to. RequireNodeAuth
		// has already established who is asking, so this is a comparison, not a
		// second authentication — but it is still a check that has to fail closed.
		// A request with no node identity in context must not match a token, and
		// comparing an absent identity as "" would match nothing only by luck.
		// The token is spent either way: it was consumed above, so a wrong node
		// cannot retry with it, and the rightful node gets a fresh token on its
		// next pending_notify.
		requester, hasNode := auth.GetNodeID(r.Context())
		if !hasNode || requester != tokenNodeID {
			log.Printf("[buffer-fetch] token for node=%s redeemed by node=%q; refusing (buffer=%s)",
				tokenNodeID, requester, bufferID)
			respondError(w, http.StatusForbidden, "fetch token was issued to a different node")
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
