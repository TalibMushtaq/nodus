package handler

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"time"

	"github.com/TalibMushtaq/nodus/services/relay/internal/auth"
	"github.com/TalibMushtaq/nodus/services/relay/internal/db"
	"github.com/TalibMushtaq/nodus/services/relay/internal/hub"
	"github.com/google/uuid"
)

// resolveConflictRequest is the optional body of a conflict resolution. When
// `keep_version` is set the Relay records it as the file's preferred version
// (ADR-0003 addendum), so the chosen side becomes the one clients treat as
// current. Omitting it requests the pre-existing behaviour (acknowledge and
// leave the newest version current).
type resolveConflictRequest struct {
	KeepVersion *int `json:"keep_version"`
}

// ResolveConflict marks a file's flagged (conflicted) versions resolved and
// records a `CONFLICT_RESOLVED` sync event so every Storage Node clears the
// conflict. Mobile has no browser session cookie for the WebSocket event path,
// so it resolves over HTTP; the relay pushes the event to connected nodes, and
// any node that is offline picks it up on its next `sync_hello`.
//
// Resolution is an acknowledgement, never a deletion: version rows and shards
// are retained, and choosing a version only records a preference.
func ResolveConflict(pool *db.Pool, h *hub.Hub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		accountID, ok := auth.GetAccountID(r.Context())
		if !ok {
			respondError(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		fileID := r.PathValue("file_id")
		if fileID == "" {
			respondError(w, http.StatusBadRequest, "missing file_id")
			return
		}

		// The body is optional; an empty body (the common case) decodes to an
		// error that we deliberately ignore.
		var req resolveConflictRequest
		if r.Body != nil {
			_ = json.NewDecoder(r.Body).Decode(&req)
		}

		ctx := r.Context()
		tx, err := pool.Begin(ctx)
		if err != nil {
			respondError(w, http.StatusInternalServerError, "failed to begin")
			return
		}
		defer tx.Rollback(ctx) //nolint:errcheck

		// Serialize per account so the relay-origin sequence cannot race.
		if _, err := tx.Exec(ctx,
			`SELECT pg_advisory_xact_lock(hashtext($1))`, "relay-events:"+accountID); err != nil {
			respondError(w, http.StatusInternalServerError, "failed to lock")
			return
		}

		// A chosen version must exist and belong to this account before it can
		// become the file's preferred version.
		if req.KeepVersion != nil {
			var exists bool
			if err := tx.QueryRow(ctx, `
				SELECT EXISTS(
					SELECT 1 FROM file_versions fv
					JOIN files f ON f.file_id = fv.file_id
					WHERE fv.file_id = $1 AND fv.version_number = $2 AND f.account_id = $3
				)
			`, fileID, *req.KeepVersion, accountID).Scan(&exists); err != nil {
				respondError(w, http.StatusInternalServerError, "failed to validate version")
				return
			}
			if !exists {
				respondError(w, http.StatusBadRequest, "unknown keep_version for this file")
				return
			}
			if _, err := tx.Exec(ctx, `
				UPDATE files SET preferred_version = $1, updated_at = NOW()
				WHERE file_id = $2 AND account_id = $3
			`, *req.KeepVersion, fileID, accountID); err != nil {
				respondError(w, http.StatusInternalServerError, "failed to set preferred version")
				return
			}
		}

		// Live `file_versions` is keyed by (file_id, version_number) and scoped
		// through `files.account_id`.
		tag, err := tx.Exec(ctx, `
			UPDATE file_versions SET conflict_status = 'resolved'
			WHERE file_id = $1 AND conflict_status = 'flagged'
			  AND EXISTS (
				SELECT 1 FROM files f
				WHERE f.file_id = file_versions.file_id AND f.account_id = $2
			  )
		`, fileID, accountID)
		if err != nil {
			respondError(w, http.StatusInternalServerError, "failed to resolve")
			return
		}
		resolved := tag.RowsAffected()

		// Clear the notice so a later conflict on this file can alert again.
		if _, err := tx.Exec(ctx,
			`DELETE FROM conflict_notices WHERE account_id = $1 AND file_id = $2`,
			accountID, fileID); err != nil {
			respondError(w, http.StatusInternalServerError, "failed to clear notice")
			return
		}

		// A per-account relay origin avoids the global
		// UNIQUE(origin_id, origin_sequence) colliding across accounts.
		originID := "relay:" + accountID
		eventID := uuid.NewString()
		eventPayload := map[string]any{"file_id": fileID}
		if req.KeepVersion != nil {
			eventPayload["keep_version"] = *req.KeepVersion
		}
		payload, _ := json.Marshal(eventPayload)

		var seq int64
		if err := tx.QueryRow(ctx, `
			SELECT COALESCE(MAX(origin_sequence), 0) + 1 FROM sync_events WHERE origin_id = $1
		`, originID).Scan(&seq); err != nil {
			respondError(w, http.StatusInternalServerError, "failed to allocate sequence")
			return
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO sync_events (event_id, account_id, origin_id, origin_sequence, event_type, payload, timestamp)
			VALUES ($1, $2, $3, $4, 'CONFLICT_RESOLVED', $5, NOW())
		`, eventID, accountID, originID, seq, payload); err != nil {
			respondError(w, http.StatusInternalServerError, "failed to record event")
			return
		}

		if err := tx.Commit(ctx); err != nil {
			respondError(w, http.StatusInternalServerError, "failed to commit")
			return
		}

		// Best-effort prompt delivery; offline nodes catch up on next sync.
		pushConflictResolved(ctx, pool, h, accountID, originID, seq, eventID, payload)

		response := map[string]any{"status": "ok", "resolved": resolved}
		if req.KeepVersion != nil {
			response["preferred_version"] = *req.KeepVersion
		}
		respondJSON(w, http.StatusOK, response)
	}
}

// pushConflictResolved sends an `event_batch` carrying the resolution to each
// connected node of the account. A node that is offline simply applies it when
// it next sends `sync_hello`.
func pushConflictResolved(
	ctx context.Context,
	pool *db.Pool,
	h *hub.Hub,
	accountID, originID string,
	seq int64,
	eventID string,
	payload []byte,
) {
	if h == nil {
		return
	}
	item := SyncEventItem{
		EventID:        eventID,
		OriginID:       originID,
		OriginSequence: seq,
		Type:           "CONFLICT_RESOLVED",
		Payload:        payload,
		Timestamp:      time.Now().UTC().Format(time.RFC3339),
	}
	batch, err := json.Marshal(EventBatchPayload{Events: []SyncEventItem{item}})
	if err != nil {
		return
	}
	env := ProtocolEnvelope{
		Type:          "event_batch",
		SchemaVersion: "1.0.0",
		MessageID:     uuid.NewString(),
		Timestamp:     time.Now().UTC().Format(time.RFC3339),
		Payload:       batch,
	}
	envBytes, err := json.Marshal(env)
	if err != nil {
		return
	}

	rows, err := pool.Query(ctx, `SELECT node_id FROM storage_nodes WHERE account_id = $1`, accountID)
	if err != nil {
		return
	}
	defer rows.Close()
	for rows.Next() {
		var nodeID string
		if rows.Scan(&nodeID) != nil {
			continue
		}
		if !h.SendToNode(nodeID, envBytes) {
			log.Printf("[conflict] node %s offline; resolution applies on next sync", nodeID)
		}
	}
}
