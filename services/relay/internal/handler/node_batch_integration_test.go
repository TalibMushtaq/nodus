package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/TalibMushtaq/nodus/services/relay/internal/config"
	"github.com/TalibMushtaq/nodus/services/relay/internal/db"
)

// A Storage Node was a privileged peer: its batches skipped the origin binding,
// the event-type whitelist, and the sequence check that a device's batches must
// pass. These tests pin the three invariants for the node path, and pin the
// deliberate difference in how an unprojectable event is handled.

// nodeBatchFixture seeds an account, one node, and one file/version pair for it.
func nodeBatchFixture(t *testing.T) (ctx context.Context, pool *db.Pool, account, node, file string) {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set; skipping integration test")
	}
	ctx = context.Background()
	require.NoError(t, db.RunMigrations(url))
	p, err := db.Open(ctx, &config.Config{DatabaseURL: url})
	require.NoError(t, err)
	t.Cleanup(p.Close)

	suffix := fmt.Sprint(time.Now().UnixNano())
	account, node, file = "acct-nb-"+suffix, "node-nb-"+suffix, "file-nb-"+suffix
	_, err = p.Exec(ctx, `INSERT INTO accounts (account_id, email, password_hash) VALUES ($1, $2, 'hash')`,
		account, account+"@test.local")
	require.NoError(t, err)
	_, err = p.Exec(ctx, `INSERT INTO storage_nodes (node_id, account_id, public_key) VALUES ($1, $2, 'pk')`, node, account)
	require.NoError(t, err)
	_, err = p.Exec(ctx, `INSERT INTO files (file_id, account_id) VALUES ($1, $2)`, file, account)
	require.NoError(t, err)
	_, err = p.Exec(ctx, `INSERT INTO file_versions (file_id, version_number, version_hash, shard_count) VALUES ($1, 1, 'vh', 1)`, file)
	require.NoError(t, err)
	return ctx, p, account, node, file
}

func shardStoredEvent(eventID, node, file string, seq int64) SyncEventItem {
	payload, _ := json.Marshal(map[string]any{
		"file_id": file, "version_number": 1, "shard_index": 0,
		"hash": "h", "size_bytes": 1234,
	})
	return SyncEventItem{
		EventID: eventID, OriginID: node, OriginSequence: seq,
		Type: "FILE_SHARD_STORED", Payload: payload,
		Timestamp: time.Now().UTC().Format(time.RFC3339),
	}
}

func journaledCount(t *testing.T, ctx context.Context, pool *db.Pool, account string) int {
	t.Helper()
	var n int
	require.NoError(t, pool.QueryRow(ctx,
		`SELECT count(*) FROM sync_events WHERE account_id = $1`, account).Scan(&n))
	return n
}

// TestNodeBatchAcceptsOwnOriginWhitelistedSequence is the baseline: a well-formed
// node batch still applies, so the new checks did not break the happy path.
func TestNodeBatchAcceptsOwnOriginWhitelistedSequence(t *testing.T) {
	ctx, pool, account, node, file := nodeBatchFixture(t)

	ack := applyNodeBatch(ctx, pool, account, node, []SyncEventItem{
		shardStoredEvent("evt-1", node, file, 1),
		shardStoredEvent("evt-2", node, file, 2),
	})
	require.True(t, *ack.OK, "reason: %s", ack.Reason)
	require.Equal(t, []string{"evt-1", "evt-2"}, ack.AppliedEventIDs)
	require.Equal(t, int64(2), *ack.LastOriginSequence)
	require.Equal(t, 2, journaledCount(t, ctx, pool, account))

	// The projection really happened, not just the journal row.
	var status string
	require.NoError(t, pool.QueryRow(ctx, `
		SELECT status FROM file_locations
		WHERE file_id = $1 AND version_number = 1 AND shard_index = 0`, file).Scan(&status))
	require.Equal(t, "NODE_STORED", status)
}

// TestNodeBatchRejectsForeignOrigin covers impersonation: a node claiming an
// origin_id it does not own would otherwise write into another peer's sequence
// space and, because the cursor upsert is keyed on origin_id, advance that
// peer's cursor.
func TestNodeBatchRejectsForeignOrigin(t *testing.T) {
	ctx, pool, account, node, file := nodeBatchFixture(t)

	ack := applyNodeBatch(ctx, pool, account, node, []SyncEventItem{
		shardStoredEvent("evt-forged", "some-other-device", file, 1),
	})
	require.False(t, *ack.OK)
	require.Equal(t, "origin_mismatch", ack.Reason)
	require.Empty(t, ack.AppliedEventIDs)
	require.Zero(t, journaledCount(t, ctx, pool, account), "a rejected batch must journal nothing")

	// The forged peer's cursor must not have been created or advanced either.
	var cursorRows int
	require.NoError(t, pool.QueryRow(ctx,
		`SELECT count(*) FROM sync_cursors WHERE account_id = $1 AND peer_id = 'some-other-device'`, account).Scan(&cursorRows))
	require.Zero(t, cursorRows, "an impersonated origin must not gain a cursor")
}

// TestNodeBatchRejectsUnprojectableType covers the broadcast primitive. The
// projection switch has no default arm, so an unknown type was journaled and
// acked as applied — and then handed to every device during catch-up sync.
func TestNodeBatchRejectsUnprojectableType(t *testing.T) {
	ctx, pool, account, node, file := nodeBatchFixture(t)

	for _, eventType := range []string{"DEVICE_REVOKED", "ACCOUNT_DELETED", "NOT_A_REAL_TYPE", ""} {
		ack := applyNodeBatch(ctx, pool, account, node, []SyncEventItem{{
			EventID: "evt-" + eventType, OriginID: node, OriginSequence: 1,
			Type: eventType, Payload: []byte(`{"file_id":"` + file + `"}`),
			Timestamp: time.Now().UTC().Format(time.RFC3339),
		}})
		require.False(t, *ack.OK, "type %q must be rejected", eventType)
		require.Equal(t, "event_type_not_allowed", ack.Reason)
	}
	require.Zero(t, journaledCount(t, ctx, pool, account),
		"an unprojectable type must not reach the event log")
}

// TestNodeBatchRejectsSequenceRegression pins monotonicity per origin, which
// cursor-based catch-up sync depends on: an event below the accepted max would
// never be delivered to a peer asking for "everything after N".
func TestNodeBatchRejectsSequenceRegression(t *testing.T) {
	ctx, pool, account, node, file := nodeBatchFixture(t)

	require.True(t, *applyNodeBatch(ctx, pool, account, node, []SyncEventItem{
		shardStoredEvent("evt-a", node, file, 5),
		shardStoredEvent("evt-b", node, file, 6),
	}).OK)

	for _, seq := range []int64{6, 5, 1} {
		ack := applyNodeBatch(ctx, pool, account, node, []SyncEventItem{
			shardStoredEvent(fmt.Sprintf("evt-regress-%d", seq), node, file, seq),
		})
		require.False(t, *ack.OK, "sequence %d must be rejected against an accepted max of 6", seq)
		require.Equal(t, "sequence_regression", ack.Reason)
		require.Equal(t, int64(6), *ack.LastOriginSequence,
			"the rejection must report the accepted cursor so the node can re-derive")
	}
	require.Equal(t, 2, journaledCount(t, ctx, pool, account))
}

// TestNodeBatchRejectsInBatchRegression checks the check is applied within a
// batch, not only against the stored cursor: two events in one batch whose
// sequences go backwards must be caught.
func TestNodeBatchRejectsInBatchRegression(t *testing.T) {
	ctx, pool, account, node, file := nodeBatchFixture(t)

	ack := applyNodeBatch(ctx, pool, account, node, []SyncEventItem{
		shardStoredEvent("evt-hi", node, file, 9),
		shardStoredEvent("evt-lo", node, file, 8),
	})
	require.False(t, *ack.OK)
	require.Equal(t, "sequence_regression", ack.Reason)
	require.Empty(t, ack.AppliedEventIDs, "the whole batch must be rejected, not just the regressing event")
	require.Zero(t, journaledCount(t, ctx, pool, account))
}

// TestNodeBatchRejectsWholeBatchOnPolicyViolation is the all-or-nothing half: a
// batch whose *last* event carries a foreign origin must apply none of its
// events, so a misbehaving sender never half-lands a batch.
func TestNodeBatchRejectsWholeBatchOnPolicyViolation(t *testing.T) {
	ctx, pool, account, node, file := nodeBatchFixture(t)

	ack := applyNodeBatch(ctx, pool, account, node, []SyncEventItem{
		shardStoredEvent("evt-good-1", node, file, 1),
		shardStoredEvent("evt-good-2", node, file, 2),
		shardStoredEvent("evt-bad", "impostor", file, 3),
	})
	require.False(t, *ack.OK)
	require.Equal(t, "origin_mismatch", ack.Reason)
	require.Zero(t, journaledCount(t, ctx, pool, account),
		"no event from a rejected batch may be journaled")
}

// TestNodeBatchSkipsUnprojectableEventWithoutWedging is the deliberate
// difference from the device path. A node's outbox is a durable ordered queue,
// so a permanently-invalid row at the head must not block every later event —
// otherwise one bad row stalls that node's sync forever.
func TestNodeBatchSkipsUnprojectableEventWithoutWedging(t *testing.T) {
	ctx, pool, account, node, file := nodeBatchFixture(t)

	// A different account's file: a legitimate, permanently unprojectable event.
	otherAccount, otherFile := account+"-other", file+"-other"
	_, err := pool.Exec(ctx, `INSERT INTO accounts (account_id, email, password_hash) VALUES ($1, $2, 'hash')`,
		otherAccount, otherAccount+"@test.local")
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO files (file_id, account_id) VALUES ($1, $2)`, otherFile, otherAccount)
	require.NoError(t, err)

	ack := applyNodeBatch(ctx, pool, account, node, []SyncEventItem{
		shardStoredEvent("evt-foreign", node, otherFile, 1), // unprojectable
		shardStoredEvent("evt-good", node, file, 2),         // must still land
	})
	require.True(t, *ack.OK, "reason: %s", ack.Reason)
	require.Equal(t, []string{"evt-good"}, ack.AppliedEventIDs,
		"the unprojectable event is skipped, the rest of the batch is not blocked")
	require.Equal(t, 1, journaledCount(t, ctx, pool, account))
}

// TestNodeBatchSurvivesHardErrorInOneEvent proves the per-event savepoint works:
// a statement error in Postgres aborts the enclosing transaction, so without the
// savepoint one poisoned event would take down every later event in the batch.
func TestNodeBatchSurvivesHardErrorInOneEvent(t *testing.T) {
	ctx, pool, account, node, file := nodeBatchFixture(t)

	// An ACTIVITY_LOGGED event whose payload is not valid JSON: the json.Unmarshal
	// error is handled, so force a hard failure instead by colliding on a
	// NOT NULL column via a payload the projection cannot fill. Using a
	// KEY_ENVELOPE_ADDED with an empty encrypted_key exercises the insert path.
	poison, _ := json.Marshal(map[string]any{
		"file_id": file, "recipient_id": "dev-x", "recipient_kind": "device",
	})
	ack := applyNodeBatch(ctx, pool, account, node, []SyncEventItem{
		{EventID: "evt-envelope", OriginID: node, OriginSequence: 1,
			Type: "KEY_ENVELOPE_ADDED", Payload: poison, Timestamp: time.Now().UTC().Format(time.RFC3339)},
		shardStoredEvent("evt-after", node, file, 2),
	})
	require.True(t, *ack.OK, "reason: %s", ack.Reason)
	require.Contains(t, ack.AppliedEventIDs, "evt-after",
		"an event after a failing one must still be applied")
}

// TestNodeBatchRejectsEmptyNodeIdentity guards the case where the handler routes
// an unauthenticated client down the node path with no node id.
func TestNodeBatchRejectsEmptyNodeIdentity(t *testing.T) {
	ctx, pool, account, _, _ := nodeBatchFixture(t)

	ack := applyNodeBatch(ctx, pool, account, "", []SyncEventItem{{EventID: "e", OriginID: "", OriginSequence: 1}})
	require.False(t, *ack.OK)
	require.Equal(t, "no_node_identity", ack.Reason)
}

// TestNodeAllowedEventTypeMatchesProjections pins the whitelist to the types that
// actually have a projection arm, so a future projection cannot be silently
// shadowed by a stale whitelist and a removed one cannot linger.
func TestNodeAllowedEventTypeMatchesProjections(t *testing.T) {
	projected := []string{
		"FILE_CREATED", "FOLDER_CREATED", "FOLDER_DELETED",
		"KEY_ENVELOPE_ADDED", "FOLDER_KEY_ENVELOPE_ADDED",
		"FILE_VERSION_ADDED", "FILE_MODIFIED", "FILE_DELETED",
		"TOMBSTONE_CREATED", "TOMBSTONE_REMOVED", "CONFLICT_RESOLVED",
		"FILE_SHARD_STORED", "ACTIVITY_LOGGED",
	}
	for _, eventType := range projected {
		require.True(t, nodeAllowedEventType(eventType), "%s has a projection and must be allowed", eventType)
	}

	// DEVICE_REVOKED is server-only: revocation goes through DELETE /devices/{id}.
	require.False(t, nodeAllowedEventType("DEVICE_REVOKED"))
	require.False(t, nodeAllowedEventType("NODE_REGISTERED"))
	require.False(t, nodeAllowedEventType(""))

	// FILE_SHARD_STORED is node-only: a device has no business claiming a shard
	// is durably stored on a node's behalf.
	require.True(t, nodeAllowedEventType("FILE_SHARD_STORED"))
	require.False(t, deviceAllowedEventType("FILE_SHARD_STORED"))
}
