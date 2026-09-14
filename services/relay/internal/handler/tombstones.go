package handler

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"time"

	"github.com/TalibMushtaq/nodus/services/relay/internal/auth"
	"github.com/TalibMushtaq/nodus/services/relay/internal/buffer"
	"github.com/TalibMushtaq/nodus/services/relay/internal/db"
	"github.com/TalibMushtaq/nodus/services/relay/internal/hub"
	"github.com/google/uuid"
)

// TombstoneNodeStatus is one storage node's progress on a tombstoned entity.
// A nil deleted_at means the node has not applied the tombstone yet; a nil
// purged_at means it still holds the data (needed for restore).
type TombstoneNodeStatus struct {
	NodeID    string     `json:"node_id"`
	DeletedAt *time.Time `json:"deleted_at"`
	PurgedAt  *time.Time `json:"purged_at"`
}

// TombstoneResponse is one soft-deleted entity for the Tombstone (trash) view.
type TombstoneResponse struct {
	EntityType       string                `json:"entity_type"`
	EntityID         string                `json:"entity_id"`
	EncryptedName    *string               `json:"encrypted_name"`
	DeletedAt        time.Time             `json:"deleted_at"`
	PurgeAfter       time.Time             `json:"purge_after"`
	PurgeRequestedAt *time.Time            `json:"purge_requested_at"`
	Nodes            []TombstoneNodeStatus `json:"nodes"`
}

// ListTombstones returns the account's soft-deleted files and folders with
// per-node delete/purge progress. Folder names come from the folders table,
// file names from files; both are opaque to the Relay.
func ListTombstones(pool *db.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		accountID, ok := auth.GetAccountID(r.Context())
		if !ok {
			respondError(w, http.StatusUnauthorized, "unauthorized")
			return
		}

		rows, err := pool.Query(r.Context(), `
			SELECT t.entity_type, t.entity_id, t.deleted_at, t.purge_after, t.purge_requested_at,
			       COALESCE(f.encrypted_name, fo.encrypted_name) AS encrypted_name
			FROM tombstones t
			LEFT JOIN files f ON t.entity_type = 'file' AND f.file_id = t.entity_id
			LEFT JOIN folders fo ON t.entity_type = 'folder' AND fo.folder_id = t.entity_id
			WHERE t.account_id = $1
			ORDER BY t.deleted_at DESC
		`, accountID)
		if err != nil {
			respondError(w, http.StatusInternalServerError, "failed to query tombstones")
			return
		}
		defer rows.Close()

		tombstones := make([]TombstoneResponse, 0)
		for rows.Next() {
			var t TombstoneResponse
			if err := rows.Scan(&t.EntityType, &t.EntityID, &t.DeletedAt, &t.PurgeAfter, &t.PurgeRequestedAt, &t.EncryptedName); err != nil {
				respondError(w, http.StatusInternalServerError, "failed to scan tombstone")
				return
			}
			t.Nodes = []TombstoneNodeStatus{}
			tombstones = append(tombstones, t)
		}
		if err := rows.Err(); err != nil {
			respondError(w, http.StatusInternalServerError, "failed to read tombstones")
			return
		}

		for i := range tombstones {
			nodes, err := tombstoneNodeStatuses(r.Context(), pool, accountID, tombstones[i].EntityType, tombstones[i].EntityID)
			if err != nil {
				respondError(w, http.StatusInternalServerError, "failed to query tombstone node status")
				return
			}
			tombstones[i].Nodes = nodes
		}
		respondJSON(w, http.StatusOK, tombstones)
	}
}

// tombstoneNodeStatuses merges the owning nodes (from file_locations, for
// files) with any ack rows so the UI can show "waiting for node" per node.
func tombstoneNodeStatuses(ctx context.Context, pool *db.Pool, accountID, entityType, entityID string) ([]TombstoneNodeStatus, error) {
	statuses := map[string]TombstoneNodeStatus{}

	if entityType == "file" {
		nodeRows, err := pool.Query(ctx, `SELECT DISTINCT node_id FROM file_locations WHERE file_id = $1`, entityID)
		if err != nil {
			return nil, err
		}
		for nodeRows.Next() {
			var nodeID string
			if err := nodeRows.Scan(&nodeID); err != nil {
				nodeRows.Close()
				return nil, err
			}
			statuses[nodeID] = TombstoneNodeStatus{NodeID: nodeID}
		}
		nodeRows.Close()
		if err := nodeRows.Err(); err != nil {
			return nil, err
		}
	}

	ackRows, err := pool.Query(ctx, `
		SELECT node_id, deleted_at, purged_at
		FROM tombstone_node_status
		WHERE account_id = $1 AND entity_type = $2 AND entity_id = $3
	`, accountID, entityType, entityID)
	if err != nil {
		return nil, err
	}
	defer ackRows.Close()
	for ackRows.Next() {
		var s TombstoneNodeStatus
		if err := ackRows.Scan(&s.NodeID, &s.DeletedAt, &s.PurgedAt); err != nil {
			return nil, err
		}
		statuses[s.NodeID] = s
	}
	if err := ackRows.Err(); err != nil {
		return nil, err
	}

	out := make([]TombstoneNodeStatus, 0, len(statuses))
	for _, s := range statuses {
		out = append(out, s)
	}
	return out, nil
}

// PurgeTombstone permanently deletes a soft-deleted entity. It marks the
// tombstone purge-requested, asks every owning node to remove the data, and
// (when there are no owning nodes) finalizes immediately. The tombstone is
// removed only once all owning nodes report `purged`.
func PurgeTombstone(pool *db.Pool, h *hub.Hub, buf *buffer.Buffer) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		accountID, ok := auth.GetAccountID(r.Context())
		if !ok {
			respondError(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		entityType := r.PathValue("entity_type")
		entityID := r.PathValue("entity_id")
		if entityType != "file" && entityType != "folder" {
			respondError(w, http.StatusBadRequest, "entity_type must be file or folder")
			return
		}

		var exists bool
		if err := pool.QueryRow(r.Context(), `
			SELECT EXISTS(SELECT 1 FROM tombstones WHERE account_id=$1 AND entity_type=$2 AND entity_id=$3)
		`, accountID, entityType, entityID).Scan(&exists); err != nil {
			respondError(w, http.StatusInternalServerError, "failed to check tombstone")
			return
		}
		if !exists {
			respondError(w, http.StatusNotFound, "tombstone not found")
			return
		}

		if _, err := pool.Exec(r.Context(), `
			UPDATE tombstones SET purge_requested_at = COALESCE(purge_requested_at, NOW())
			WHERE account_id=$1 AND entity_type=$2 AND entity_id=$3
		`, accountID, entityType, entityID); err != nil {
			respondError(w, http.StatusInternalServerError, "failed to mark purge requested")
			return
		}

		nodes, err := owningNodes(r.Context(), pool, accountID, entityType, entityID)
		if err != nil {
			respondError(w, http.StatusInternalServerError, "failed to resolve owning nodes")
			return
		}
		for _, nodeID := range nodes {
			sendTombstoneControl(h, nodeID, map[string]any{
				"type":    "purge_tombstone",
				"payload": map[string]any{"entity_type": entityType, "entity_id": entityID},
			})
		}

		// No node holds the data (local-only file, or a folder): nothing to wait
		// for, so finalize on the Relay immediately.
		if len(nodes) == 0 {
			if err := finalizeTombstonePurge(r.Context(), pool, buf, accountID, entityType, entityID); err != nil {
				respondError(w, http.StatusInternalServerError, "failed to purge")
				return
			}
			respondJSON(w, http.StatusOK, map[string]any{"status": "purged"})
			return
		}

		respondJSON(w, http.StatusAccepted, map[string]any{"status": "purging", "nodes": nodes})
	}
}

// RestoreTombstone cancels a soft delete: it removes the tombstone (and node
// status) and tells nodes to drop their tombstone so the retained data is not
// purged at the original deadline. The entity's file/folder row is untouched.
func RestoreTombstone(pool *db.Pool, h *hub.Hub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		accountID, ok := auth.GetAccountID(r.Context())
		if !ok {
			respondError(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		entityType := r.PathValue("entity_type")
		entityID := r.PathValue("entity_id")
		if entityType != "file" && entityType != "folder" {
			respondError(w, http.StatusBadRequest, "entity_type must be file or folder")
			return
		}

		nodes, err := owningNodes(r.Context(), pool, accountID, entityType, entityID)
		if err != nil {
			respondError(w, http.StatusInternalServerError, "failed to resolve owning nodes")
			return
		}
		for _, nodeID := range nodes {
			sendTombstoneControl(h, nodeID, map[string]any{
				"type":    "restore_tombstone",
				"payload": map[string]any{"entity_type": entityType, "entity_id": entityID},
			})
		}

		if _, err := pool.Exec(r.Context(), `
			DELETE FROM tombstones WHERE account_id=$1 AND entity_type=$2 AND entity_id=$3
		`, accountID, entityType, entityID); err != nil {
			respondError(w, http.StatusInternalServerError, "failed to restore")
			return
		}
		if _, err := pool.Exec(r.Context(), `
			DELETE FROM tombstone_node_status WHERE account_id=$1 AND entity_type=$2 AND entity_id=$3
		`, accountID, entityType, entityID); err != nil {
			respondError(w, http.StatusInternalServerError, "failed to clear node status")
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

// ApplyTombstoneAck records a node's delete/purge progress and finalizes a
// pending purge once every owning node has purged.
func ApplyTombstoneAck(ctx context.Context, pool *db.Pool, buf *buffer.Buffer, accountID, nodeID, entityType, entityID, status string) error {
	switch status {
	case "deleted":
		_, err := pool.Exec(ctx, `
			INSERT INTO tombstone_node_status (account_id, entity_type, entity_id, node_id, deleted_at)
			VALUES ($1, $2, $3, $4, NOW())
			ON CONFLICT (account_id, entity_type, entity_id, node_id)
			DO UPDATE SET deleted_at = COALESCE(tombstone_node_status.deleted_at, EXCLUDED.deleted_at)
		`, accountID, entityType, entityID, nodeID)
		return err
	case "purged":
		if _, err := pool.Exec(ctx, `
			INSERT INTO tombstone_node_status (account_id, entity_type, entity_id, node_id, deleted_at, purged_at)
			VALUES ($1, $2, $3, $4, NOW(), NOW())
			ON CONFLICT (account_id, entity_type, entity_id, node_id)
			DO UPDATE SET purged_at = EXCLUDED.purged_at
		`, accountID, entityType, entityID, nodeID); err != nil {
			return err
		}
		return maybeFinalizePurge(ctx, pool, buf, accountID, entityType, entityID)
	default:
		return nil
	}
}

// maybeFinalizePurge removes the entity once a purge was requested and every
// owning node has acked `purged`.
func maybeFinalizePurge(ctx context.Context, pool *db.Pool, buf *buffer.Buffer, accountID, entityType, entityID string) error {
	var requested bool
	if err := pool.QueryRow(ctx, `
		SELECT EXISTS(
			SELECT 1 FROM tombstones
			WHERE account_id=$1 AND entity_type=$2 AND entity_id=$3 AND purge_requested_at IS NOT NULL
		)
	`, accountID, entityType, entityID).Scan(&requested); err != nil {
		return err
	}
	if !requested {
		return nil
	}

	nodes, err := owningNodes(ctx, pool, accountID, entityType, entityID)
	if err != nil {
		return err
	}
	if len(nodes) > 0 {
		var pending int
		if err := pool.QueryRow(ctx, `
			SELECT COUNT(*) FROM (
				SELECT unnest($3::text[]) AS node_id
			) owning
			LEFT JOIN tombstone_node_status s
			  ON s.account_id=$1 AND s.entity_type=$2 AND s.entity_id=$4 AND s.node_id = owning.node_id
			WHERE s.purged_at IS NULL
		`, accountID, entityType, nodes, entityID).Scan(&pending); err != nil {
			return err
		}
		if pending > 0 {
			return nil
		}
	}
	return finalizeTombstonePurge(ctx, pool, buf, accountID, entityType, entityID)
}

// collectFileBufferIDs returns every non-null `buffer_id` referenced by the
// entity's files (recursively, for a folder). The purge below deletes the
// `file_locations` rows that carry these ids, after which the TTL sweep — which
// only scans existing rows — can never see the files again. Without unlinking
// them here, every shard still buffered at purge time leaks on disk forever.
func collectFileBufferIDs(ctx context.Context, pool *db.Pool, entityType, entityID string) ([]string, error) {
	var query string
	if entityType == "file" {
		query = `SELECT DISTINCT buffer_id FROM file_locations
		         WHERE file_id = $1 AND buffer_id IS NOT NULL`
	} else {
		// Recursive folder walk: child folders plus the files directly under the
		// folder or any descendant.
		query = `WITH RECURSIVE sub AS (
		             SELECT folder_id FROM folders WHERE folder_id = $1
		             UNION ALL
		             SELECT f.folder_id FROM folders f JOIN sub ON f.parent_folder_id = sub.folder_id
		         )
		         SELECT DISTINCT fl.buffer_id
		         FROM file_locations fl
		         JOIN files fi ON fi.file_id = fl.file_id
		         WHERE fl.buffer_id IS NOT NULL
		           AND (fi.file_id = $1 OR fi.parent_folder_id IN (SELECT folder_id FROM sub))`
	}

	rows, err := pool.Query(ctx, query, entityID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// finalizeTombstonePurge deletes the entity's Relay-side data and the tombstone.
func finalizeTombstonePurge(ctx context.Context, pool *db.Pool, buf *buffer.Buffer, accountID, entityType, entityID string) error {
	// Resolve the buffer files before the rows that reference them disappear.
	bufferIDs, err := collectFileBufferIDs(ctx, pool, entityType, entityID)
	if err != nil {
		return err
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) // nolint:errcheck

	if entityType == "file" {
		if _, err := tx.Exec(ctx, `DELETE FROM file_locations WHERE file_id=$1`, entityID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `DELETE FROM file_versions WHERE file_id=$1`, entityID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `DELETE FROM key_envelopes WHERE file_id=$1`, entityID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `DELETE FROM files WHERE file_id=$1 AND account_id=$2`, entityID, accountID); err != nil {
			return err
		}
	} else {
		// folder_key_envelopes cascade from the folders row (migration 017), so
		// deleting the folder also removes its keys.
		if _, err := tx.Exec(ctx, `DELETE FROM folders WHERE folder_id=$1 AND account_id=$2`, entityID, accountID); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(ctx, `DELETE FROM tombstones WHERE account_id=$1 AND entity_type=$2 AND entity_id=$3`, accountID, entityType, entityID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM tombstone_node_status WHERE account_id=$1 AND entity_type=$2 AND entity_id=$3`, accountID, entityType, entityID); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}

	// Unlink buffer files only after the rows are gone, so a failed commit can
	// never strand a referenced-but-missing shard. Best-effort: a failure is
	// logged and the orphan is reclaimable manually.
	if buf != nil {
		for _, id := range bufferIDs {
			if err := buf.Delete(id); err != nil {
				log.Printf("[tombstone] warning: failed to delete buffer file %s: %v", id, err)
			}
		}
	}
	return nil
}

// owningNodes lists the storage nodes whose data a purge/restore must reach.
// Files are tracked per node in `file_locations`; folders have no such table,
// so every active node of the account is asked (an unmatched node no-ops but
// still acks, which keeps the purge accounting consistent and removes the
// node's folder row).
func owningNodes(ctx context.Context, pool *db.Pool, accountID, entityType, entityID string) ([]string, error) {
	if entityType == "file" {
		rows, err := pool.Query(ctx, `SELECT DISTINCT node_id FROM file_locations WHERE file_id=$1`, entityID)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		nodes := make([]string, 0)
		for rows.Next() {
			var nodeID string
			if err := rows.Scan(&nodeID); err != nil {
				return nil, err
			}
			nodes = append(nodes, nodeID)
		}
		return nodes, rows.Err()
	}

	rows, err := pool.Query(ctx, `
		SELECT node_id FROM storage_nodes
		WHERE account_id = $1 AND status = 'ACTIVE'
	`, accountID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	nodes := make([]string, 0)
	for rows.Next() {
		var nodeID string
		if err := rows.Scan(&nodeID); err != nil {
			return nil, err
		}
		nodes = append(nodes, nodeID)
	}
	return nodes, rows.Err()
}

// sendTombstoneControl wraps a tombstone control message in a protocol
// envelope and delivers it to one node if it is connected.
func sendTombstoneControl(h *hub.Hub, nodeID string, body map[string]any) {
	if h == nil {
		return
	}
	msgType, _ := body["type"].(string)
	payload, err := json.Marshal(body["payload"])
	if err != nil {
		return
	}
	env := ProtocolEnvelope{
		Type:          msgType,
		SchemaVersion: "1.0.0",
		MessageID:     uuid.NewString(),
		Timestamp:     time.Now().UTC().Format(time.RFC3339),
		Payload:       payload,
	}
	envBytes, err := json.Marshal(env)
	if err != nil {
		return
	}
	if !h.SendToNode(nodeID, envBytes) {
		log.Printf("[tombstone] node %s offline; %s will apply on next sync/GC", nodeID, msgType)
	}
}

// redeliverPendingPurges re-sends `purge_tombstone` controls to a node for every
// file whose purge was requested and that the node holds shards for. The
// initial control is fire-and-forget: a node that was offline, or that had not
// yet applied the delete event, would otherwise never finish the purge and the
// Relay would wait forever for its `purged` ack. Called when a node re-syncs
// (after the missing-events batch has been queued on the same connection, so
// the tombstone is applied first).
func redeliverPendingPurges(ctx context.Context, c *hub.Client, pool *db.Pool, h *hub.Hub) {
	if pool == nil || c.NodeID == "" || c.AccountID == "" {
		return
	}
	entities, err := pendingPurgesForNode(ctx, pool, c.AccountID, c.NodeID)
	if err != nil {
		log.Printf("[tombstone] pending purge scan failed for node %s: %v", c.NodeID, err)
		return
	}
	for _, e := range entities {
		sendTombstoneControl(h, c.NodeID, map[string]any{
			"type":    "purge_tombstone",
			"payload": map[string]any{"entity_type": e.EntityType, "entity_id": e.EntityID},
		})
	}
}

// purgeEntity is one pending purge target for a node.
type purgeEntity struct {
	EntityType string
	EntityID   string
}

// pendingPurgesForNode lists entities whose purge was requested and whose
// control this node should (re)receive: files the node holds shards for, and
// every folder of the account (folders have no per-node location, so each
// active node is asked to drop its folder row).
func pendingPurgesForNode(ctx context.Context, pool *db.Pool, accountID, nodeID string) ([]purgeEntity, error) {
	rows, err := pool.Query(ctx, `
		SELECT DISTINCT t.entity_type, t.entity_id
		FROM tombstones t
		JOIN file_locations fl ON fl.file_id = t.entity_id AND fl.node_id = $2
		WHERE t.account_id = $1
		  AND t.entity_type = 'file'
		  AND t.purge_requested_at IS NOT NULL
		UNION
		SELECT DISTINCT t.entity_type, t.entity_id
		FROM tombstones t
		JOIN storage_nodes n ON n.account_id = t.account_id AND n.node_id = $2 AND n.status = 'ACTIVE'
		WHERE t.account_id = $1
		  AND t.entity_type = 'folder'
		  AND t.purge_requested_at IS NOT NULL
	`, accountID, nodeID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var entities []purgeEntity
	for rows.Next() {
		var e purgeEntity
		if rows.Scan(&e.EntityType, &e.EntityID) == nil {
			entities = append(entities, e)
		}
	}
	return entities, rows.Err()
}
